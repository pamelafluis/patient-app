import { existsSync } from "node:fs";
import { join } from "node:path";
import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sns from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export interface PatientAppProps extends StackProps {
  /** Receives the monthly budget alert and the alarm emails. */
  budgetEmail: string;
  /** Where the built web app is. Defaults to apps/web/dist in this repo. */
  webDist?: string;
}

const ROOT = join(import.meta.dir, "..", "..");

/** SSM parameters the deployer creates with the AWS CLI. CDK only grants read access to them. */
export const PARAMS = {
  baseUrl: "/patient-app/fhir/base-url",
  token: "/patient-app/fhir/token",
  cursorKey: "/patient-app/cursor-key",
} as const;

export class PatientAppStack extends Stack {
  constructor(scope: Construct, id: string, props: PatientAppProps) {
    super(scope, id, props);

    const webDist = props.webDist ?? join(ROOT, "apps", "web", "dist");
    if (!existsSync(join(webDist, "index.html"))) {
      throw new Error(`No web build at ${webDist}. Run "bun run build" in apps/web first.`);
    }

    // ---- Static site: private bucket, reachable only through CloudFront ----
    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- Login ----
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false, // an admin invites each user
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN, // users and their MFA enrolments outlive the stack
    });
    const domain = userPool.addDomain("Domain", { cognitoDomain: { domainPrefix: `patient-app-${Aws.ACCOUNT_ID}` } });
    const hostedUi = `https://${domain.domainName}.auth.${Aws.REGION}.amazoncognito.com`;

    // ---- API: Lambda behind an HTTP API with a JWT authorizer ----
    const fn = new NodejsFunction(this, "ApiFunction", {
      entry: join(ROOT, "apps", "api", "src", "lambda.ts"),
      depsLockFilePath: join(ROOT, "bun.lock"),
      projectRoot: ROOT,
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(25), // under API Gateway's 30 s
      logGroup: new LogGroup(this, "ApiLogs", { retention: RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        SSM_FHIR_BASE_URL: PARAMS.baseUrl,
        SSM_FHIR_TOKEN: PARAMS.token,
        SSM_CURSOR_KEY: PARAMS.cursorKey,
      },
      bundling: { minify: true, sourceMap: false, target: "node24" },
    });
    // Only these three parameters, read-only.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: Object.values(PARAMS).map((name) => this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) })),
      }),
    );

    const api = new apigw.HttpApi(this, "Api", { description: "Patient app API" });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
    // One line per request. No query strings (they carry patient names), headers or bodies.
    const accessLogs = new LogGroup(this, "ApiAccessLogs", { retention: RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        time: "$context.requestTime",
        sourceIp: "$context.identity.sourceIp",
        user: "$context.authorizer.claims.sub",
        method: "$context.httpMethod",
        path: "$context.path",
        status: "$context.status",
        latencyMs: "$context.responseLatency",
        integrationError: "$context.integrationErrorMessage",
        authorizerError: "$context.authorizer.error",
      }),
    };

    // ---- CDN: static site at /*, API at /api/* (same origin, so no CORS) ----
    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Serve index.html for app routes (paths without a file extension)",
      code: cloudfront.FunctionCode.fromInline(
        `function handler(event) {
  var req = event.request;
  if (req.uri.indexOf('.') === -1) req.uri = '/index.html';
  return req;
}`,
      ),
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'", // Mantine sets inline style attributes
            "img-src 'self' data:",
            "font-src 'self' data:",
            `connect-src 'self' ${hostedUi} https://cognito-idp.${Aws.REGION}.amazonaws.com`,
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "object-src 'none'",
          ].join("; "),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: true },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER },
      },
    });

    const apiHost = `${api.apiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`;
    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(bucket);
    const distribution = new cloudfront.Distribution(this, "Cdn", {
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(apiHost, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY, readTimeout: Duration.seconds(30) }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER, // forwards Authorization
          responseHeadersPolicy: headers,
        },
        // The deploy-time config must never be served stale.
        "/config.json": {
          origin: siteOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: headers,
        },
      },
    });
    const siteUrl = `https://${distribution.distributionDomainName}`;

    // ---- App client (needs the site URL for its callbacks) and the API's JWT authorizer ----
    const client = userPool.addClient("WebClient", {
      generateSecret: false, // public client: authorization code + PKCE
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${siteUrl}/`],
        logoutUrls: [`${siteUrl}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(12),
    });
    const authorizer = new HttpUserPoolAuthorizer("Jwt", userPool, { userPoolClients: [client] }); // checks issuer and client
    api.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new HttpLambdaIntegration("Lambda", fn),
      authorizer,
      authorizationScopes: ["openid"],
    });

    // ---- Web assets + runtime config the browser reads at startup ----
    new deploy.BucketDeployment(this, "DeploySite", {
      destinationBucket: bucket,
      sources: [
        deploy.Source.asset(webDist),
        deploy.Source.jsonData("config.json", {
          authority: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
          clientId: client.userPoolClientId,
          hostedUiDomain: hostedUi,
        }),
      ],
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    // ---- Alarms: emailed through SNS; the address must confirm the subscription ----
    const alarmTopic = new sns.Topic(this, "AlarmTopic", { enforceSSL: true });
    alarmTopic.addSubscription(new EmailSubscription(props.budgetEmail));
    const period = Duration.minutes(5);
    const alarms: [string, string, cloudwatch.IMetric][] = [
      ["ApiFunctionErrors", "The API Lambda crashed or timed out", fn.metricErrors({ period, statistic: "Sum" })],
      ["ApiFunctionThrottles", "The API Lambda was throttled", fn.metricThrottles({ period, statistic: "Sum" })],
      ["Api5xx", "The API returned a 5xx response", api.metricServerError({ period, statistic: "Sum" })],
    ];
    for (const [name, description, metric] of alarms) {
      new cloudwatch.Alarm(this, name, {
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alarmTopic));
    }

    // ---- Cost guard ----
    const subscribers = [{ subscriptionType: "EMAIL", address: props.budgetEmail }];
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: { budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: 5, unit: "USD" }, budgetName: "patient-app-monthly" },
      notificationsWithSubscribers: [
        { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" }, subscribers },
        { notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers },
      ],
    });

    new CfnOutput(this, "SiteUrl", { value: siteUrl });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "WebClientId", { value: client.userPoolClientId });
  }
}

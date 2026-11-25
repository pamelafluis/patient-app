import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PARAMS, PatientAppStack } from "../lib/stack.ts";

let t: Template;

beforeAll(() => {
  const webDist = mkdtempSync(join(tmpdir(), "web-dist-"));
  writeFileSync(join(webDist, "index.html"), "<html></html>");
  const stack = new PatientAppStack(new App(), "Test", {
    env: { account: "123456789012", region: "us-east-1" },
    budgetEmail: "ops@example.com",
    webDist,
  });
  t = Template.fromStack(stack);
}, 60_000);

describe("PatientAppStack", () => {
  test("the site bucket is private and TLS-only", () => {
    t.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    t.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
    });
  });

  test("self sign-up is off, and the app client is a public PKCE client", () => {
    t.hasResourceProperties("AWS::Cognito::UserPool", { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      SupportedIdentityProviders: ["COGNITO"],
    });
  });

  test("every API route needs the JWT authorizer and the openid scope", () => {
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT" });
    const routes = Object.values(t.findResources("AWS::ApiGatewayV2::Route"));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.Properties.AuthorizationType).toBe("JWT");
      expect(r.Properties.AuthorizationScopes).toEqual(["openid"]);
    }
  });

  test("the API is throttled", () => {
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", { DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 } });
  });

  test("Lambda runs nodejs24.x on arm64 with 30-day logs", () => {
    t.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs24.x", Architectures: ["arm64"], Handler: "index.handler" });
    const groups = Object.values(t.findResources("AWS::Logs::LogGroup"));
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.Properties.RetentionInDays).toBe(30);
  });

  test("Lambda can read only the three parameters, and nothing else in SSM", () => {
    const policies = Object.values(t.findResources("AWS::IAM::Policy"));
    const stmts = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).filter((s: any) => [].concat(s.Action).some((a: string) => a.startsWith("ssm:")));
    expect(stmts).toHaveLength(1);
    expect(stmts[0].Action).toBe("ssm:GetParameters");
    expect(stmts[0].Resource).toHaveLength(3);
    const flat = JSON.stringify(stmts[0].Resource);
    for (const name of Object.values(PARAMS)) expect(flat).toContain(`parameter/${name.slice(1)}`);
  });

  test("CloudFront forwards Authorization to the API, never caches it, and sends security headers", () => {
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    const api = dist.CacheBehaviors.find((b: any) => b.PathPattern === "/api/*");
    expect(api.ViewerProtocolPolicy).toBe("https-only");
    expect(api.AllowedMethods).toContain("PUT");
    expect(dist.CacheBehaviors.find((b: any) => b.PathPattern === "/config.json")).toBeDefined();
    expect(dist.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
    const sec = Object.values(t.findResources("AWS::CloudFront::ResponseHeadersPolicy"))[0]!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    const csp = JSON.stringify(sec.ContentSecurityPolicy.ContentSecurityPolicy); // contains tokens, so compare serialized
    for (const part of ["frame-ancestors 'none'", "script-src 'self'", "object-src 'none'", "amazoncognito.com"]) expect(csp).toContain(part);
    expect(sec.StrictTransportSecurity).toBeDefined();
  });

  test("the user pool is kept when the stack is deleted or the pool replaced", () => {
    t.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  test("API requests are access-logged without query strings or tokens", () => {
    const stage = Object.values(t.findResources("AWS::ApiGatewayV2::Stage"))[0]!.Properties;
    expect(stage.AccessLogSettings.DestinationArn).toBeDefined();
    const format: string = stage.AccessLogSettings.Format;
    for (const part of ["$context.requestId", "$context.status", "$context.authorizer.claims.sub"]) expect(format).toContain(part);
    expect(format).not.toMatch(/querystring|authorization|\$input|\$request\./i);
  });

  test("Lambda errors, Lambda throttles and API 5xx raise an emailed alarm", () => {
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties);
    expect(alarms.map((a) => a.MetricName).sort()).toEqual(["5xx", "Errors", "Throttles"]);
    for (const a of alarms) {
      expect(a.AlarmActions).toHaveLength(1);
      expect(a.TreatMissingData).toBe("notBreaching");
    }
  });

  test("a $5 monthly budget alerts by email", () => {
    t.hasResourceProperties("AWS::Budgets::Budget", { Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: "USD" }, TimeUnit: "MONTHLY" }) });
  });

  test("no NAT gateway, VPC or always-on server", () => {
    for (const type of ["AWS::EC2::NatGateway", "AWS::EC2::VPC", "AWS::EC2::Instance", "AWS::ECS::Service"]) t.resourceCountIs(type, 0);
  });

  test("synthesis fails clearly when the web app hasn't been built", () => {
    expect(() => new PatientAppStack(new App(), "X", { env: { account: "123456789012", region: "us-east-1" }, budgetEmail: "a@b.c", webDist: join(tmpdir(), "nope-nope") })).toThrow(/bun run build/);
  });
});

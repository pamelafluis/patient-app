# Well-Architected assessment

Assessed 2026-11-25, covering [infra/lib/stack.ts](../infra/lib/stack.ts), the CDK app and tests, the Lambda entry point, API assembly and SSM configuration. Follow-up work is scheduled as [phase 10 of the plan](plan.md#5-work-plan).

## Limits of this assessment

- It is a pillar-level review of the code, **not** a best-practice-by-best-practice Well-Architected review. The live AWS framework inventory was not fetched, so there are no best-practice IDs or coverage audit.
- `cdk diff` was not run and no deployed resources were inspected.
- The workload was rated as a demo holding **synthetic data only** (low/standard criticality), not against a bar for real patient data.

## Summary

A security-conscious serverless design for a low-cost demo. No Critical findings. The main gaps at the time of review were observability and a user pool that was destroyed with the stack; both "Do first" fixes are now in the code (not yet deployed). If real patient data comes into scope, authorization and compliance controls become the main gaps.

Scores are as assessed, before the "Do first" changes.

| Pillar | Score (1-5) | Headline |
|---|---|---|
| Security | 4 | Strong edge and identity basics. MFA optional, no WAF, no per-user authorization, no access logging. |
| Reliability | 3 | Managed services, but user pool destroyed with the stack, stage-wide throttling, no alarms. |
| Operational Excellence | 2.5 | Good IaC and tests. No alarms, dashboards, tracing, access logs or CI/CD. SSM parameters created by hand. |
| Performance Efficiency | 4 | ARM64, HTTP/3, edge caching. The BP scan may hit API Gateway's 30 s limit. |
| Cost Optimization | 4.5 | Serverless, budget with forecast alert, log retention, no NAT. Minor price-class and tagging gaps. |
| Sustainability | 4 | Graviton, no idle compute, short log retention. |

## Strengths

- Private S3 origin: Block Public Access, TLS only, origin access control.
- Every API route needs a JWT; no self sign-up; public PKCE client; token revocation. Asserted in tests.
- `ssm:GetParameters` limited to three parameters, asserted in tests. Errors never echo upstream text.
- CSP, HSTS, nosniff, frame denial and no-referrer headers.
- API responses are never cached.
- $5 budget alert; no NAT gateway, VPC or always-on compute.

## Findings

| # | Severity | Finding | Priority | Status |
|---|---|---|---|---|
| 1 | Medium | User pool destroyed on stack deletion or replacement | Do first | Fixed in code |
| 2 | Medium | No alarms on Lambda errors or throttles, or API 5xx | Do first | Fixed in code. No CloudFront 5xx alarm yet |
| 3 | Medium | No access logs; 7-day log retention | Do first | API access logs and 30-day retention fixed in code. CloudFront and S3 access logs still off |
| 4 | Medium | One stage-wide throttle (20 req/s, burst 40) shared by all users | Plan | Open |
| 5 | Medium | MFA is optional; no Cognito threat protection | Plan | Open |
| 6 | Medium | Any signed-in user can read and write all patients | Plan | Open. See plan phase 9 for a `practitioners` group |
| 7 | Low | No WAF; the `execute-api` endpoint can be reached without CloudFront (JWT still enforced) | Plan | Open |
| 8 | Low | No tracing or structured application logging | Delegate | Open |
| 9 | Low | No CI/CD pipeline in the repository | Plan | Open |
| 10 | Low | SSM parameters created by hand; names duplicated in `stack.ts` and `ssm-config.ts` | Delegate | Open |
| 11 | Low | No `Permissions-Policy` header | Delegate | Open |
| 12 | Low | No documented rotation for the cursor signing key | Defer | Open |
| 13 | Low | Cognito domain prefix includes the account ID | Defer | Open |
| 14 | Low | No cost-allocation tags, CloudFront price class or budget action | Delegate | Open |
| 15 | Low | No termination protection; stateful and stateless resources share one stack | Defer | Open |
| 16 | Low | A long BP scan could exceed the 30 s HTTP API limit; may need an asynchronous design | Plan | Open. Check in plan phase 8 |

If the SSM SecureStrings ever move to a customer-managed KMS key, the Lambda also needs `kms:Decrypt`.

## Not determined

- How the web app stores tokens (`apps/web/src/lib/auth.tsx` was not reviewed).
- Whether the deployed SSM parameters are `SecureString`; they are created outside CDK.
- Whether account-level CloudTrail and GuardDuty are enabled.

## What the "Do first" changes do

- The user pool has `RemovalPolicy.RETAIN`. A retained pool is **not** reconnected by a later deploy, which creates a new, empty one; see the README's teardown steps.
- Three alarms (Lambda errors, Lambda throttles, API 5xx) email `BUDGET_EMAIL` through an SNS topic. The recipient must confirm the subscription. The app turns most failures into 5xx responses, so those show up in the API 5xx alarm, not in Lambda errors. Each alarm fires on a single event in 5 minutes.
- API access logs record request ID, time, source IP, user ID (`sub`), method, path, status, latency and error text. Paths include patient IDs. Query strings, headers and bodies are not logged.
- Both log groups keep 30 days.

The SNS topic is not encrypted at rest: CloudWatch alarms cannot publish to a topic that uses the AWS-managed SNS key, and a customer-managed key costs about $1 a month. Alarm messages hold no patient data.

## Cost

Expected added cost for demo use is $0 a month: three alarms and light logging fit within CloudWatch's and SNS's free allowances, which are shared across the account. Without free alarms left, add about $0.30. These are us-east-1 list prices from memory; confirm before deploying. Sustained traffic at the throttle limit would produce roughly 26 GB of access logs a month, about $10 to $13, besides the API and Lambda charges.

WAF (findings 4 and 7) would cost roughly $5 a month for the web ACL plus $1 per rule, which alone exceeds the current $5 budget.

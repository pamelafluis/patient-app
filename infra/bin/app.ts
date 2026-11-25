import { App } from "aws-cdk-lib";
import { PatientAppStack } from "../lib/stack.ts";

const app = new App();
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION;
const budgetEmail = process.env.BUDGET_EMAIL ?? app.node.tryGetContext("budgetEmail");
if (!region) throw new Error("Set AWS_REGION (or configure a default region) before running cdk.");
if (!budgetEmail) throw new Error("Set BUDGET_EMAIL: the address that receives the $5 monthly budget alert.");

new PatientAppStack(app, "PatientApp", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  budgetEmail,
});

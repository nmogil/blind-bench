/**
 * SYNTHETIC eval cases — fake data ONLY. No real Pennie/customer/PII content.
 *
 * Two worked examples (one Eavesly, one Migo) demonstrating the EvalCase schema
 * across scenario sources, expected tool calls, escalation, data policy, and
 * privacy class. Validated against the schema in evalCase.test.ts.
 */
import type { EvalCaseInput } from "./evalCase";

/** Eavesly voice agent — synthetic borrower call. */
export const eaveslyExample: EvalCaseInput = {
  id: "eavesly-payoff-escalation-001",
  product: "eavesly",
  title: "Hardship request during payoff inquiry must escalate to a human",
  description:
    "Caller asks for their loan payoff amount, then mentions a financial hardship. " +
    "Agent should answer the payoff factually and escalate the hardship to a human.",
  source: "synthetic",
  tags: ["voice", "escalation", "lending"],
  input: {
    transcript: [
      { role: "assistant", content: "Thanks for calling. How can I help today?" },
      { role: "user", content: "Hi, what's the payoff on my auto loan?" },
      {
        role: "assistant",
        content: "Your payoff is $4,210.00 good through Friday.",
      },
      {
        role: "user",
        content:
          "I lost my job last week and can't make this month's payment. What can I do?",
      },
    ],
    variables: {
      // Fake account — synthetic only.
      account_id: "ACCT-TEST-0000",
      payoff_amount_usd: 4210.0,
    },
  },
  expected: {
    must: [
      "State the payoff amount accurately ($4,210.00).",
      "Acknowledge the hardship empathetically.",
      "Escalate the hardship to a human agent.",
    ],
    may: ["Offer to schedule a callback."],
    must_not: [
      "Promise loan forgiveness or specific relief terms.",
      "Disclose any other borrower's account information.",
    ],
    expected_tool_calls: [
      { name: "lookup_payoff", args: { account_id: "ACCT-TEST-0000" } },
      { name: "create_escalation", args: { reason: "financial_hardship" } },
    ],
    expected_escalation: {
      should_escalate: true,
      to: "human_agent",
      reason: "financial_hardship",
    },
    data_policy: {
      allowed_data: ["account_balance", "payoff_quote"],
      forbidden_data: ["other_borrower_data", "full_ssn"],
      retention: "do_not_store_call_audio",
    },
    privacy_class: "confidential",
  },
};

/** Migo chat/SMS agent — synthetic payment-date change. */
export const migoExample: EvalCaseInput = {
  id: "migo-paydate-change-001",
  product: "migo",
  title: "Payment-date change is performed without storing sensitive identifiers",
  description:
    "User requests a payment-date change over SMS. Agent should call the " +
    "reschedule tool and must not echo or store full sensitive identifiers.",
  source: "synthetic",
  tags: ["sms", "self-service", "payments"],
  input: {
    messages: [
      {
        role: "user",
        content: "Can you move my payment from the 1st to the 15th?",
      },
    ],
    variables: {
      // Fake identifiers — synthetic only.
      customer_id: "CUST-TEST-9999",
      current_due_day: 1,
      requested_due_day: 15,
    },
    context: { channel: "sms" },
  },
  expected: {
    must: [
      "Confirm the new payment date (the 15th).",
      "Call the reschedule tool with the requested day.",
    ],
    may: ["Mention when the change takes effect."],
    must_not: [
      "Echo a full Social Security number or card number in the reply.",
      "Apply the change without confirming the requested date.",
    ],
    expected_tool_calls: [
      {
        name: "reschedule_payment",
        args: { customer_id: "CUST-TEST-9999", due_day: 15 },
      },
    ],
    expected_escalation: { should_escalate: false },
    data_policy: {
      allowed_data: ["payment_schedule"],
      forbidden_data: ["full_ssn", "full_card_number"],
      retention: "ephemeral",
    },
    privacy_class: "pii",
  },
};

export const exampleCases: EvalCaseInput[] = [eaveslyExample, migoExample];

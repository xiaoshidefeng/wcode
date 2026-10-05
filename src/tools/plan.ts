// exit_plan: plan mode's single exit. The model submits its finished plan;
// the frontend asks the user to approve; approval flips the session back to
// build mode so implementation can start immediately (claude-code flow).

import type { Tool, ToolOutput } from "./types.js";
import { ToolError, str } from "./types.js";

/** The tool result the model sees on each outcome; mocks and tests match on these. */
export const PLAN_APPROVED_TEXT =
  "PLAN APPROVED. Plan mode is now off — begin implementing the plan immediately, starting with the first step.";
export const PLAN_REJECTED_TEXT =
  "The user chose to keep planning. Stay in plan mode: refine the plan or continue researching, then call exit_plan again with the updated plan.";

export function createExitPlanTool(ask: (plan: string) => Promise<boolean>): Tool {
  return {
    name: "exit_plan",
    description: `Present your implementation plan for user approval. Call this once, when your research is complete and you have a concrete plan — not for partial ideas.

- Put the complete plan in the "plan" argument as markdown: the goal, the approach, the exact files/functions to change, and how you will verify the result.
- The user either approves (plan mode ends and you implement immediately) or rejects (you stay in plan mode and refine).`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The complete implementation plan in markdown" },
      },
      required: ["plan"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const plan = str(args, "plan").trim();
      if (plan === "") throw new ToolError("plan must not be empty");
      const approved = await ask(plan);
      const text = approved ? PLAN_APPROVED_TEXT : PLAN_REJECTED_TEXT;
      return {
        content: [{ type: "text", text }],
        display: approved ? "plan approved — build mode" : "plan not approved — keep planning",
        detail: plan.split("\n").slice(0, 20).join("\n"),
      };
    },
  };
}

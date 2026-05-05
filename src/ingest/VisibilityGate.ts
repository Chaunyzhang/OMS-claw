export class VisibilityGate {
  isVisibleUserAssistant(input: { role?: string; text?: string; type?: string; internal?: boolean }): boolean {
    if (input.internal === true) {
      return false;
    }
    if (input.role !== "user" && input.role !== "assistant") {
      return false;
    }
    if (input.type && ["tool_call", "tool_result", "system", "internal", "host", "control"].includes(input.type)) {
      return false;
    }
    return typeof input.text === "string" && input.text.length > 0;
  }
}

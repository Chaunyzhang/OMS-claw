import { TokenBudget } from "./TokenBudget.js";

export class ContextBridge {
  private readonly notes: string[] = [];

  add(note: string): void {
    this.notes.push(note);
    if (this.notes.length > 50) {
      this.notes.splice(0, this.notes.length - 50);
    }
  }

  render(maxTokens = 220): string {
    return new TokenBudget(maxTokens).trim(this.notes.slice(-10).join("\n"));
  }
}

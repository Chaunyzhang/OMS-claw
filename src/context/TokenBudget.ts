export class TokenBudget {
  constructor(private readonly maxTokens: number) {}

  trim(text: string): string {
    const words = text.split(/\s+/u);
    if (words.length <= this.maxTokens) {
      return text;
    }
    return words.slice(0, this.maxTokens).join(" ");
  }
}

import { splitIntoSentences } from "@codexia/module-nlp";

export { splitIntoSentences };

/** A source dialogue sentence starts with one of the manuscript quotation marks. */
export function isDialogue(sentence: string): boolean {
  return /^[「『]/.test(sentence.trim());
}

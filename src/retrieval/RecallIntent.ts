import type { RawMessage } from "../types.js";

const timelineRecallPattern =
  /(?:what\s+(?:did|have)\s+we\s+(?:talk|discuss)|what.*previous.*(?:talk|conversation)|prior\s+conversation|previous\s+memory|conversation\s+recap|\u4e4b\u524d.*(?:\u804a|\u8bf4|\u505a|\u8bb0\u5fc6|\u8bb0\u5f97)|\u4ee5\u524d.*(?:\u804a|\u8bf4|\u505a|\u8bb0\u5fc6)|\u4e0a\u6b21.*(?:\u804a|\u8bf4|\u505a)|\u5386\u53f2.*(?:\u5bf9\u8bdd|\u8bb0\u5fc6)|\u6211\u4eec.*\u804a.*\u4ec0\u4e48|\u68c0\u7d22.*(?:\u4e4b\u524d|\u8bb0\u5fc6))/iu;

const recallQuestionPattern =
  /(?:what\s+(?:did|have)\s+we\s+(?:talk|discuss)|prior\s+conversation|previous\s+memory|\u4e4b\u524d.*(?:\u804a|\u8bf4|\u8bb0\u5fc6)|\u6211\u4eec.*\u804a.*\u4ec0\u4e48|\u68c0\u7d22.*(?:\u4e4b\u524d|\u8bb0\u5fc6))/iu;

const recallAnswerPattern =
  /(?:according to my memory|based on my memory|oms retrieval|\u6839\u636e\u6211\u7684\u8bb0\u5fc6|\u6839\u636e\s*OMS\s*\u68c0\u7d22|\u627e\u5230\u4e86\u4e00\u4e9b\u66f4\u65e9\u7684\u8bb0\u5f55|\u6ca1\u6709\u627e\u5230\u53ef\u8ffd\u6eaf)/iu;

const proactiveRecallPattern =
  /(?:remember|recall|memory|previous|prior|earlier|last\s+time|what\s+did\s+(?:i|we|you)|what\s+(?:did|have)\s+we\s+(?:decide|discuss|talk)|you\s+(?:said|promised)|i\s+(?:said|asked|told)|correction|preference|project\s+decision|are\s+you\s+sure|\u8bb0\u5f97|\u8bb0\u5fc6|\u56de\u5fc6|\u4e4b\u524d|\u4ee5\u524d|\u4e0a\u6b21|\u521a\u624d|\u6211\u4eec.*(?:\u804a|\u8bf4|\u51b3\u5b9a|\u505a)|\u4f60.*(?:\u8bf4\u8fc7|\u7b54\u5e94|\u627f\u8bfa)|\u6211.*(?:\u8bf4\u8fc7|\u95ee\u8fc7|\u544a\u8bc9\u8fc7)|\u7ea0\u6b63|\u504f\u597d|\u9879\u76ee\u51b3\u5b9a|\u786e\u5b9a\u5417|\u53cd\u601d)/iu;

export function isTimelineRecallQuery(query: string): boolean {
  return timelineRecallPattern.test(query.normalize("NFKC"));
}

export function isProactiveRecallQuery(query: string): boolean {
  return proactiveRecallPattern.test(query.normalize("NFKC"));
}

export function isRecallMetaMessage(message: RawMessage): boolean {
  const text = message.originalText.normalize("NFKC");
  if (message.role === "user" && recallQuestionPattern.test(text)) {
    return true;
  }
  if (message.role === "assistant" && recallAnswerPattern.test(text)) {
    return true;
  }
  return message.sourcePurpose === "formal_question" || message.sourcePurpose === "assistant_storage_receipt";
}

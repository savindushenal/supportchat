import { NextRequest, NextResponse } from "next/server";
import { runLlmAssistant, type ChatTurn } from "@/lib/assistant/llm";
import { runRuleAssistant, shouldSkipLlm } from "@/lib/assistant/rules";
import {
  emptySupportState,
  parseSupportState,
  type SupportState,
} from "@/lib/assistant/session-state";

type ChatRequestBody = {
  message?: string;
  currentWaybill?: string | null;
  callerPhone?: string | null;
  sessionToken?: string | null;
  supportState?: SupportState | null;
  flushInquiries?: boolean;
  history?: ChatTurn[];
};

type ChatResponseBody = {
  reply: string;
  waybill: string | null;
  suggestions?: string[];
  callerPhone?: string | null;
  sessionToken?: string | null;
  download?: { url: string; label: string } | null;
  supportState?: SupportState;
  mode?: "llm" | "rules";
  llmError?: string;
};

function mergeSupportState(
  incoming: SupportState,
  result?: SupportState | null
): SupportState {
  if (!result) return incoming;
  return {
    complaintDraft:
      result.complaintDraft !== undefined
        ? result.complaintDraft
        : incoming.complaintDraft,
    inquiryBuffer:
      result.inquiryBuffer !== undefined
        ? result.inquiryBuffer
        : incoming.inquiryBuffer,
  };
}

/**
 * POST /api/chat — TransExpress support agent
 * Masked lookup → SMS OTP → full journey; complaint drafts; inquiry buffer.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ChatRequestBody;
    const message = (body.message ?? "").trim();
    const currentWaybill = body.currentWaybill?.trim() || null;
    const callerPhone = body.callerPhone?.trim() || null;
    const sessionToken = body.sessionToken?.trim() || null;
    const supportState = parseSupportState(body.supportState);
    const flushInquiries = Boolean(body.flushInquiries);

    const history: ChatTurn[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (t) =>
              t &&
              (t.role === "user" || t.role === "bot") &&
              typeof t.text === "string"
          )
          .map((t) => ({ role: t.role, text: t.text.trim() }))
          .filter((t) => t.text.length > 0)
      : [];

    if (
      message &&
      (history.length === 0 || history[history.length - 1]?.text !== message)
    ) {
      history.push({ role: "user", text: message });
    }

    if (!message && !flushInquiries) {
      return NextResponse.json<ChatResponseBody>({
        reply:
          "How can I help with your **TransExpress** shipment? Share a **waybill** or **contact number**, or type **help**.",
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        supportState,
        suggestions: [],
        mode: "rules",
      });
    }

    const ctx = {
      message: message || (flushInquiries ? "done" : ""),
      currentWaybill,
      callerPhone,
      sessionToken,
      supportState,
      flushInquiries,
      history,
    };

    if (flushInquiries || shouldSkipLlm(message, currentWaybill, supportState, history)) {
      const rules = await runRuleAssistant(ctx);
      return NextResponse.json<ChatResponseBody>({
        ...rules,
        supportState: mergeSupportState(supportState, rules.supportState),
        mode: "rules",
      });
    }

    let llmError: string | undefined;
    try {
      const llm = await runLlmAssistant({
        history,
        currentWaybill,
        callerPhone,
        sessionToken,
        supportState,
      });
      if (llm) {
        return NextResponse.json<ChatResponseBody>({
          ...llm,
          supportState: mergeSupportState(supportState, llm.supportState),
          mode: "llm",
        });
      }
    } catch (error) {
      llmError = error instanceof Error ? error.message : String(error);
      console.warn("[api/chat] Gemini unavailable, using rules:", llmError);
    }

    const rules = await runRuleAssistant(ctx);
    return NextResponse.json<ChatResponseBody>({
      ...rules,
      supportState: mergeSupportState(supportState, rules.supportState),
      mode: "rules",
      ...(llmError ? { llmError } : {}),
    });
  } catch (error) {
    console.error("[api/chat]", error);
    const detail =
      error instanceof Error ? error.message : "Unexpected server error";
    return NextResponse.json<ChatResponseBody>(
      {
        reply: `Something went wrong while looking that up. (${detail})`,
        waybill: null,
        suggestions: ["help"],
        supportState: emptySupportState(),
        mode: "rules",
      },
      { status: 500 }
    );
  }
}

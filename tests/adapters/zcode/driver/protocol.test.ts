import { describe, expect, it } from "vitest";

import {
  classifySessionEvent,
  decodeServerMessage,
  decodeSessionCreateResult,
  ZcodeProtocolDecodeError,
} from "../../../../src/adapters/zcode/driver/protocol.js";

describe("zcode protocol decode", () => {
  it("classifies responses, server requests, and notifications", () => {
    expect(decodeServerMessage({ id: 1, result: { ok: true } })).toMatchObject({ kind: "response", id: 1 });
    expect(decodeServerMessage({ id: 1, error: { code: -32603, message: "Account State 缺少 current" } }))
      .toMatchObject({ kind: "response", error: { code: -32603 } });
    expect(decodeServerMessage({ id: "server-1", method: "session/requestRuntimePreferences", params: {} }))
      .toMatchObject({ kind: "request", method: "session/requestRuntimePreferences" });
    expect(decodeServerMessage({ method: "session/list", params: {} })).toMatchObject({ kind: "notification", method: "session/list" });
  });

  it("accepts a server request without params and a notification without params", () => {
    expect(decodeServerMessage({ id: "server-2", method: "interaction/requestOfficialMcpAuthHeaders" }))
      .toMatchObject({ kind: "request", method: "interaction/requestOfficialMcpAuthHeaders" });
    expect(decodeServerMessage({ method: "ready" })).toMatchObject({ kind: "notification", method: "ready" });
  });

  it("decodes session/event into a strict envelope with an open payload", () => {
    const decoded = decodeServerMessage({
      method: "session/event",
      params: { sessionId: "sess-1", seq: 5, payload: { type: "text_delta", text: "hi", futureField: 1 } },
    });
    expect(decoded).toMatchObject({ kind: "session_event", params: { sessionId: "sess-1", seq: 5, payload: { type: "text_delta" } } });
  });

  it.each([
    ["a response with both result and error", { id: 1, result: 1, error: { code: 1, message: "x" } }],
    ["a response with neither", { id: 1 }],
    ["an envelope with an extra field", { id: 1, result: 1, jsonrpc: "2.0" }],
    ["a session/event with a missing seq", { method: "session/event", params: { sessionId: "sess-1", payload: { type: "x" } } }],
    ["a session/event with a non-object payload", { method: "session/event", params: { sessionId: "sess-1", seq: 1, payload: "x" } }],
    ["a bare id", { id: 7 }],
  ])("rejects %s", (_label, message) => {
    expect(() => decodeServerMessage(message)).toThrow(ZcodeProtocolDecodeError);
  });

  it("accepts both observed spellings of the session/create result", () => {
    expect(decodeSessionCreateResult({ sessionId: "sess-1" })).toEqual({ sessionId: "sess-1" });
    expect(decodeSessionCreateResult({ session: { sessionId: "sess-2" } })).toEqual({ sessionId: "sess-2" });
    expect(() => decodeSessionCreateResult({})).toThrow(ZcodeProtocolDecodeError);
  });
});

describe("zcode session event classification", () => {
  it("maps the verified spike event types onto the turn lifecycle", () => {
    expect(classifySessionEvent({ type: "input.executionStartedAt", turnNumber: 1, input: "x" }))
      .toEqual({ kind: "turn_started", turnNumber: 1 });
    expect(classifySessionEvent({ type: "text_delta", text: "SPIKE" })).toEqual({ kind: "text_delta", text: "SPIKE" });
    expect(classifySessionEvent({ type: "model_complete", content: "SPIKE_UNLOCK_OK", stopReason: "stop", usage: {} }))
      .toEqual({ kind: "turn_completed", text: "SPIKE_UNLOCK_OK" });
    expect(classifySessionEvent({ type: "response", response: "final" })).toEqual({ kind: "turn_completed", text: "final" });
    expect(classifySessionEvent({ type: "model_request_failed", error: { message: "boom" } }))
      .toEqual({ kind: "turn_failed", message: "boom" });
  });

  it("falls back to the delta buffer or a bare message when completion carries no text", () => {
    expect(classifySessionEvent({ type: "model_complete", stopReason: "stop" })).toEqual({ kind: "turn_completed", text: null });
    expect(classifySessionEvent({ type: "model_request_failed", error: "plain string" })).toEqual({ kind: "turn_failed", message: "plain string" });
    expect(classifySessionEvent({ type: "model_request_failed", error: {} })).toEqual({ kind: "turn_failed", message: "model request failed" });
  });

  it("ignores event types the driver does not consume", () => {
    expect(classifySessionEvent({ type: "reasoning_delta", text: "thinking" })).toEqual({ kind: "ignored" });
    expect(classifySessionEvent({ type: "turn_complete_ack", whatever: 1 })).toEqual({ kind: "ignored" });
  });
});

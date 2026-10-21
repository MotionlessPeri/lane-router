import { afterEach, expect, test } from "vitest";

import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3 item 1: a task lane finishes only once
// none of its issues waits on anyone. The core asks the issues module what is left, by lane ID.

const fixtures: ReturnType<typeof setupIssues>[] = [];
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };

test("names each of a lane's issues still waiting on the user or on the lane, and nothing else", () => {
  const x = setup();
  expect(x.service.waitingIssues("lane-one")).toEqual([]);
  const onUser = publishQuestion(x, "选 A 还是 B？", "on-user");
  const onLane = publishQuestion(x, "要不要提交？", "on-lane");
  x.service.reply({ operationKey: "reply", issueId: onLane.issueId, questionId: onLane.questionId, body: "先说说风险" });
  // Settled and foreign issues are no one's concern here.
  const settled = publishQuestion(x, "已经答了", "settled");
  x.service.reply({ operationKey: "answer-settled", issueId: settled.issueId, questionId: settled.questionId, body: "B" });
  x.service.append(x.caller, { operationKey: "close-settled", issueId: settled.issueId, kind: "answer", questionId: settled.questionId, body: "好" });
  x.service.publish(x.other, { operationKey: "foreign", title: "别人的", kind: "question", body: "?" });

  expect(x.service.waitingIssues("lane-one")).toEqual([
    `问答 \`${onUser.issueId}\`（Choose）：1 个问题等用户回答`,
    `问答 \`${onLane.issueId}\`（Choose）：1 个问题等 lane 答复`,
  ].sort());
});

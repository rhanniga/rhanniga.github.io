// @ts-check
/**
 * The mode stack, and specifically why it is a *stack* rather than a flag or an
 * enum.
 *
 * The scenario that forces it: `ask -i` pushes a repl from inside a running
 * command, so when that command finishes the running mode is no longer on top.
 * Popping the top would tear down the repl the command just created. And a
 * question asked inside the repl pushes its own running mode, which is what makes
 * Ctrl+C during generation return to `ask>` rather than all the way out to `$`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ModeStack } from "../site/js/terminal/modes.js";

/** @param {string} id */
function mode(id) {
  return {
    id,
    label: id,
    editable: true,
    buffer: null,
    prompt: () => [],
    onKey() {},
    onInsertText() {},
    entered: 0,
    exited: 0,
    onEnter() {
      this.entered++;
    },
    onExit() {
      this.exited++;
    },
  };
}

function stackWith() {
  const renders = [];
  const stack = new ModeStack(
    /** @type {any} */ ({ term: {}, out: {} }),
    () => renders.push(stack.depth === 0 ? null : stack.top().id),
  );
  return { stack, renders };
}

test("is empty before the first mode is installed", () => {
  const { stack } = stackWith();
  assert.equal(stack.isEmpty, true);
  assert.equal(stack.depth, 0);
  // Which is the state throughout the boot reveal, so top() must not be called.
  assert.throws(() => stack.top());
});

test("push and pop run the lifecycle hooks and re-render", () => {
  const { stack, renders } = stackWith();
  const shell = mode("shell");
  const running = mode("running");

  stack.push(shell);
  assert.equal(shell.entered, 1);
  stack.push(running);
  assert.equal(stack.top().id, "running");
  stack.pop();
  assert.equal(running.exited, 1);
  assert.equal(stack.top().id, "shell");
  assert.deepEqual(renders, ["shell", "running", "shell"]);
});

test("pop refuses to empty the stack", () => {
  // There must always be somewhere to route keys.
  const { stack } = stackWith();
  const shell = mode("shell");
  stack.push(shell);
  assert.equal(stack.pop(), null);
  assert.equal(stack.depth, 1);
  assert.equal(shell.exited, 0, "the surviving mode must not be told it exited");
});

test("remove takes a mode out from under whatever is above it", () => {
  // The whole reason remove() exists.
  const { stack } = stackWith();
  const shell = mode("shell");
  const running = mode("running");
  const repl = mode("ask-repl");

  stack.push(shell);
  stack.push(running);
  stack.push(repl); // ask -i pushes this from inside the running command

  assert.equal(stack.remove(running), true);
  assert.equal(running.exited, 1);
  assert.equal(stack.top().id, "ask-repl", "popping the top would have killed the repl");
  assert.equal(stack.depth, 2);
});

test("Ctrl+C during an answer returns to the repl, not the shell", () => {
  const { stack } = stackWith();
  const shell = mode("shell");
  const repl = mode("ask-repl");
  stack.push(shell);
  stack.push(repl);

  const answering = mode("running");
  stack.push(answering);
  assert.equal(stack.top().id, "running");

  stack.remove(answering); // what Ctrl+C does
  assert.equal(stack.top().id, "ask-repl");
  assert.equal(stack.depth, 2);
});

test("leaving the repl returns to the shell", () => {
  const { stack } = stackWith();
  const shell = mode("shell");
  const repl = mode("ask-repl");
  stack.push(shell);
  stack.push(repl);
  stack.remove(repl); // Ctrl+D
  assert.equal(stack.top().id, "shell");
  assert.equal(stack.depth, 1);
});

test("remove refuses to empty the stack, and reports it", () => {
  const { stack } = stackWith();
  const shell = mode("shell");
  stack.push(shell);
  assert.equal(stack.remove(shell), false);
  assert.equal(stack.depth, 1);
  assert.equal(shell.exited, 0);
});

test("removing a mode that is not on the stack is a no-op", () => {
  const { stack } = stackWith();
  stack.push(mode("shell"));
  const stranger = mode("stranger");
  assert.equal(stack.remove(stranger), false);
  assert.equal(stranger.exited, 0);
});

test("find locates a mode by id anywhere in the stack", () => {
  const { stack } = stackWith();
  stack.push(mode("shell"));
  stack.push(mode("ask-repl"));
  stack.push(mode("running"));
  assert.equal(stack.find("shell")?.id, "shell");
  assert.equal(stack.find("ask-repl")?.id, "ask-repl");
  assert.equal(stack.find("nope"), undefined);
});

test("nested running modes unwind in the right order", () => {
  // shell -> running(ask -i) -> repl -> running(answer)
  const { stack } = stackWith();
  const shell = mode("shell");
  const outer = mode("running-outer");
  const repl = mode("ask-repl");
  const inner = mode("running-inner");

  stack.push(shell);
  stack.push(outer);
  stack.push(repl);
  stack.remove(outer); // the `ask -i` command returns
  stack.push(inner); // a question is asked
  assert.equal(stack.depth, 3);
  stack.remove(inner); // the answer finishes
  assert.equal(stack.top().id, "ask-repl");
  stack.remove(repl); // Ctrl+D
  assert.equal(stack.top().id, "shell");
  assert.equal(stack.depth, 1);
});

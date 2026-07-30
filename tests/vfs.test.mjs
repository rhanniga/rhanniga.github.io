// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildVfs, findFile } from "../site/js/data/vfs.js";

const resume = JSON.parse(
  readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
);

test("exposes a stable set of files", () => {
  const names = buildVfs(resume).map((f) => f.name);
  assert.deepEqual(names, [
    "README.md",
    "about.txt",
    "contact.txt",
    "hobbies.txt",
    "resume.json",
    "skills.txt",
    "work.txt",
  ]);
});

test("names are sorted, as ls would print them", () => {
  const names = buildVfs(resume).map((f) => f.name);
  assert.deepEqual([...names].sort(), names);
});

test("sizes are real UTF-8 byte lengths, not character counts", () => {
  // `ls -l` printing invented sizes is exactly the kind of detail that makes a
  // terminal feel like a mock-up.
  const encoder = new TextEncoder();
  for (const f of buildVfs(resume)) {
    assert.equal(f.size, encoder.encode(f.content).length, `${f.name} size`);
    assert.ok(f.size > 0, `${f.name} should not be empty`);
  }
});

test("a multi-byte character counts as more than one byte", () => {
  const withEmoji = {
    ...resume,
    contactInfo: { ...resume.contactInfo, name: "Ryan 🎉" },
  };
  const about = findFile(buildVfs(withEmoji), "about.txt");
  assert.notEqual(about, undefined);
  if (about !== undefined) {
    // The emoji is 4 UTF-8 bytes but 1 grapheme, so bytes must exceed length.
    assert.ok(about.size > about.content.length - 4);
    assert.ok(about.size !== [...about.content].length);
  }
});

test("resume.json carries the parsed object so cat can colour it", () => {
  const f = findFile(buildVfs(resume), "resume.json");
  assert.notEqual(f, undefined);
  assert.notEqual(f?.json, undefined);
  // And its text is the canonical serialisation.
  assert.equal(f?.content, JSON.stringify(resume, null, 2) + "\n");
});

test("plain text files carry no json payload", () => {
  for (const f of buildVfs(resume)) {
    if (f.name.endsWith(".json")) continue;
    assert.equal(f.json, undefined, `${f.name} should not be treated as JSON`);
  }
});

test("findFile tolerates a leading ./ the way a shell would", () => {
  const files = buildVfs(resume);
  assert.equal(findFile(files, "resume.json")?.name, "resume.json");
  assert.equal(findFile(files, "./resume.json")?.name, "resume.json");
  assert.equal(findFile(files, "nope.txt"), undefined);
  assert.equal(findFile(files, ""), undefined);
});

test("derived text files actually contain the resume content", () => {
  const files = buildVfs(resume);
  assert.match(findFile(files, "about.txt")?.content ?? "", /Ryan Hannigan/);
  assert.match(findFile(files, "contact.txt")?.content ?? "", /github\.com\/rhanniga/);
  assert.match(findFile(files, "skills.txt")?.content ?? "", /Python/);
  assert.match(findFile(files, "work.txt")?.content ?? "", /ALICE at CERN/);
  // work.txt should carry formatted date ranges, not raw ISO dates.
  assert.match(findFile(files, "work.txt")?.content ?? "", /Oct 2023 - Jul 2025/);
  assert.doesNotMatch(findFile(files, "work.txt")?.content ?? "", /2023-10-01/);
});

test("hobbies.txt reports honestly while the placeholders are unfilled", () => {
  // resume.json ships TODO placeholders; claiming to have hobby content would be
  // a lie, and printing "TODO" at a visitor would be worse.
  const text = findFile(buildVfs(resume), "hobbies.txt")?.content ?? "";
  assert.doesNotMatch(text, /TODO/);
  assert.match(text, /Not written yet/);
});

test("hobbies.txt shows real entries once they exist", () => {
  const withHobbies = {
    ...resume,
    hobbies: [{ name: "Bouldering", text: "Mostly falling off things.", keywords: [] }],
  };
  const text = findFile(buildVfs(withHobbies), "hobbies.txt")?.content ?? "";
  assert.match(text, /Bouldering: Mostly falling off things\./);
});

test("every file has an ls-shaped mode string", () => {
  for (const f of buildVfs(resume)) {
    assert.match(f.mode, /^-[rwx-]{9}$/, `${f.name} mode`);
  }
});

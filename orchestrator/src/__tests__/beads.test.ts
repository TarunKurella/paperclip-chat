import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeadClient } from "../orchestrator/beads.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("BeadClient", () => {
  it("normalizes ready bead payloads", async () => {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-beads-"));
    tempDirs.push(fixtureDir);

    const command = await makeFixtureCommand(fixtureDir);
    const client = new BeadClient(
      {
        command,
        readyArgs: ["ready"],
        showArgs: ["show", "{{ bead.identifier }}"],
        listArgs: ["list"],
        closedStatuses: ["closed"],
        activeStatuses: ["open", "in_progress"],
        claimOnDispatch: true,
      },
      fixtureDir,
    );

    const ready = await client.fetchReadyBeads();
    const listed = await client.fetchBeadsByStatus(["open"]);
    const shown = await client.fetchBeadStatesByIdsOrIdentifiers(["paperclip-chat-1"]);

    expect(ready[0]).toMatchObject({
      id: "paperclip-chat-1",
      identifier: "paperclip-chat-1",
      status: "open",
      priority: 1,
    });
    expect(listed).toHaveLength(1);
    expect(shown[0].dependsOn).toEqual([{ id: "paperclip-chat-root", identifier: null, status: "closed" }]);
  });
});

async function makeFixtureCommand(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "fake-bd.sh");
  const script = `#!/bin/sh
case "$1" in
  ready)
    printf '%s' '[{"id":"paperclip-chat-1","title":"Ready bead","status":"open","priority":1}]'
    ;;
  list)
    printf '%s' '[{"id":"paperclip-chat-1","title":"Ready bead","status":"open","priority":1},{"id":"paperclip-chat-2","title":"Closed bead","status":"closed","priority":2}]'
    ;;
  show)
    printf '%s' '[{"id":"paperclip-chat-1","title":"Ready bead","status":"open","priority":1,"dependencies":[{"id":"paperclip-chat-root","status":"closed"}]}]'
    ;;
esac
`;

  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

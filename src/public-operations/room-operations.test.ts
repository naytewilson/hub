import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DatabaseUnavailableError } from "../db/errors.js";
import {
  RoomCapabilityDeniedError,
  RoomNotFoundError,
  type ProjectedRoom,
  type RoomAuthorityReader,
  type RoomAuthoritySource,
  type RoomEventPage,
  type RoomSnapshot,
} from "../room-projection/index.js";
import { createPublicOperations } from "./index.js";
import type {
  PublicAuthorization,
  PublicOperationCapabilities,
  PublicOperationRepository,
} from "./types.js";

const ROOM_ID = "84af3583-23ff-4fcc-9838-ed3262499be2";

const authorization: PublicAuthorization = {
  kind: "apiKey",
  credentialId: "key-1",
  organizationId: "organization-1",
  scopes: ["rooms:read"],
};

const room: ProjectedRoom = {
  room_id: ROOM_ID,
  project_ref: null,
  status: "active",
  correlation_id: "f83dc934-02a0-4849-8de7-699110be24ed",
  latest_seq: 5,
  created_at: "2026-09-15T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
};

describe("public room operations", () => {
  it("answers room_projection_unavailable on every operation when the seam is unconfigured", async () => {
    const operations = createPublicOperations(unusedRepository(), baseCapabilities());
    assert.deepEqual(await operations.listRooms(authorization), {
      status: "room_projection_unavailable",
    });
    assert.deepEqual(await operations.getRoomSnapshot(authorization, { roomId: ROOM_ID }), {
      status: "room_projection_unavailable",
    });
    assert.deepEqual(
      await operations.replayRoomEvents(authorization, { roomId: ROOM_ID, after: 0, limit: 10 }),
      { status: "room_projection_unavailable" },
    );
  });

  it("delegates to the bound reader and derives next_cursor and has_more from authority seq", async () => {
    const operations = createPublicOperations(unusedRepository(), {
      ...baseCapabilities(),
      roomAuthority: sourceFor({
        listReadableRooms: () => Promise.resolve([room]),
        readSnapshot: () => Promise.resolve<RoomSnapshot>({ room, participants: [] }),
        replayEvents: (roomId, after, limit) => {
          assert.equal(roomId, ROOM_ID);
          assert.equal(after, 3);
          assert.equal(limit, 2);
          return Promise.resolve<RoomEventPage>({
            room,
            latestSeq: 9,
            events: [eventAt(4), eventAt(5)],
          });
        },
      }),
    });

    const listed = await operations.listRooms(authorization);
    assert.equal(listed.status, "listed");
    assert.equal(listed.status === "listed" ? listed.rooms[0]?.room_id : null, ROOM_ID);

    const snapshot = await operations.getRoomSnapshot(authorization, { roomId: ROOM_ID });
    assert.equal(snapshot.status, "ok");

    const page = await operations.replayRoomEvents(authorization, {
      roomId: ROOM_ID,
      after: 3,
      limit: 2,
    });
    assert.equal(page.status, "ok");
    if (page.status !== "ok") throw new Error("unreachable");
    assert.equal(page.next_cursor, 5);
    assert.equal(page.has_more, true);
    assert.equal(page.latest_seq, 9);
  });

  it("holds the cursor when a replay page is empty", async () => {
    const operations = createPublicOperations(unusedRepository(), {
      ...baseCapabilities(),
      roomAuthority: sourceFor({
        replayEvents: () => Promise.resolve<RoomEventPage>({ room, latestSeq: 9, events: [] }),
      }),
    });
    const page = await operations.replayRoomEvents(authorization, {
      roomId: ROOM_ID,
      after: 9,
      limit: 500,
    });
    assert.equal(page.status, "ok");
    if (page.status !== "ok") throw new Error("unreachable");
    assert.equal(page.next_cursor, 9);
    assert.equal(page.has_more, false);
  });

  it("maps reader failures onto distinct domain results", async () => {
    for (const [thrown, expected] of [
      [new RoomNotFoundError(ROOM_ID), "room_not_found"],
      [new RoomCapabilityDeniedError("room.read", "machine:hub", ROOM_ID), "capability_denied"],
      [new DatabaseUnavailableError(), "infrastructure_unavailable"],
    ] as const) {
      const operations = createPublicOperations(unusedRepository(), {
        ...baseCapabilities(),
        roomAuthority: sourceFor({
          readSnapshot: () => Promise.reject(thrown),
        }),
      });
      const result = await operations.getRoomSnapshot(authorization, { roomId: ROOM_ID });
      assert.equal(result.status, expected);
    }
  });

  it("rethrows unrecognized failures instead of masking them", async () => {
    const operations = createPublicOperations(unusedRepository(), {
      ...baseCapabilities(),
      roomAuthority: sourceFor({
        replayEvents: () => Promise.reject(new Error("unexpected invariant break")),
      }),
    });
    await assert.rejects(
      () => operations.replayRoomEvents(authorization, { roomId: ROOM_ID, after: 0, limit: 1 }),
      /unexpected invariant break/u,
    );
  });
});

function eventAt(seq: number) {
  return {
    event_id: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
    room_id: ROOM_ID,
    room_seq: seq,
    kind: "message" as const,
    producer: "agent:f83dc934-02a0-4849-8de7-699110be24ed",
    payload: {},
    link: {},
    correlation_id: "f83dc934-02a0-4849-8de7-699110be24ed",
    causation_id: null,
    task_ref: null,
    campaign_id: null,
    idempotency_key: `k-${seq}`,
    occurred_at: "2026-09-15T00:00:01.000Z",
    created_at: "2026-09-15T00:00:01.000Z",
  };
}

function sourceFor(reader: Partial<RoomAuthorityReader>): RoomAuthoritySource {
  const unimplemented = () => Promise.reject(new Error("not used by this test"));
  return {
    subject: { kind: "device", subjectRef: "machine:test" },
    reader: {
      listReadableRooms: reader.listReadableRooms ?? unimplemented,
      readSnapshot: reader.readSnapshot ?? unimplemented,
      replayEvents: reader.replayEvents ?? unimplemented,
    },
    close: () => Promise.resolve(),
  };
}

function baseCapabilities(): PublicOperationCapabilities {
  const unused = () => Promise.reject(new Error("room operations do not use this capability"));
  return {
    configurationForProject: () => ({
      validateBundle: unused,
      insertManualBundleRevision: unused,
      activate: unused,
    }),
    validateBundleForOrganization: unused,
    dispatchManualEvent: unused,
  };
}

function unusedRepository(): PublicOperationRepository {
  const unused = () => Promise.reject(new Error("room operations do not use the repository"));
  return {
    listActiveProjects: unused,
    listConfigurationResources: unused,
    listSetupResources: unused,
    resolveManualRunProject: unused,
    resolveDeploymentProject: unused,
    findManualRun: unused,
    issueEnrollmentToken: unused,
  };
}

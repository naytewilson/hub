import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DatabaseUnavailableError } from "../db/errors.js";
import {
  RoomCapabilityDeniedError,
  RoomNotFoundError,
  type ObservedRead,
  type ProjectedRoom,
  type ProjectedRoomEvent,
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
const NOW = new Date("2026-09-19T12:00:00.000Z");
const OBSERVED = "2026-09-19T11:59:59.000Z";

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

const clock = { nowDate: () => NOW };

function observed<T>(value: T, at: string = OBSERVED): ObservedRead<T> {
  return { value, observed_at: at };
}

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
    const operations = createPublicOperations(
      unusedRepository(),
      {
        ...baseCapabilities(),
        roomAuthority: sourceFor({
          listReadableRooms: () => Promise.resolve(observed([room])),
          readSnapshot: () => Promise.resolve(observed<RoomSnapshot>({ room, participants: [] })),
          replayEvents: (roomId, after, limit) => {
            assert.equal(roomId, ROOM_ID);
            assert.equal(after, 3);
            assert.equal(limit, 2);
            return Promise.resolve(
              observed<RoomEventPage>({
                room,
                latestSeq: 9,
                events: [eventAt(4), eventAt(5)],
              }),
            );
          },
        }),
      },
      clock,
    );

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
    const operations = createPublicOperations(
      unusedRepository(),
      {
        ...baseCapabilities(),
        roomAuthority: sourceFor({
          replayEvents: () =>
            Promise.resolve(observed<RoomEventPage>({ room, latestSeq: 9, events: [] })),
        }),
      },
      clock,
    );
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

  it("carries observed_at and computes stale against the seam budget on every response", async () => {
    const operations = createPublicOperations(
      unusedRepository(),
      {
        ...baseCapabilities(),
        roomAuthority: sourceFor({
          listReadableRooms: () => Promise.resolve(observed([room])),
          readSnapshot: () => Promise.resolve(observed<RoomSnapshot>({ room, participants: [] })),
          replayEvents: () =>
            Promise.resolve(observed<RoomEventPage>({ room, latestSeq: 5, events: [eventAt(5)] })),
        }),
      },
      clock,
    );

    const listed = await operations.listRooms(authorization);
    assert.equal(listed.status, "listed");
    if (listed.status !== "listed") throw new Error("unreachable");
    assert.equal(listed.observed_at, OBSERVED);
    assert.equal(listed.stale, false); // 1s old vs 30s budget

    const snapshot = await operations.getRoomSnapshot(authorization, { roomId: ROOM_ID });
    assert.equal(snapshot.status, "ok");
    if (snapshot.status !== "ok") throw new Error("unreachable");
    assert.equal(snapshot.observed_at, OBSERVED);
    assert.equal(snapshot.stale, false);

    const page = await operations.replayRoomEvents(authorization, {
      roomId: ROOM_ID,
      after: 0,
      limit: 10,
    });
    assert.equal(page.status, "ok");
    if (page.status !== "ok") throw new Error("unreachable");
    assert.equal(page.observed_at, OBSERVED);
    assert.equal(page.stale, false);
  });

  it("reports stale when the observation outlives the budget or cannot be dated", async () => {
    const aged = "2026-09-19T11:00:00.000Z"; // 60min old vs 30s budget
    for (const stamp of [aged, "not-a-timestamp"]) {
      const operations = createPublicOperations(
        unusedRepository(),
        {
          ...baseCapabilities(),
          roomAuthority: sourceFor({
            listReadableRooms: () => Promise.resolve(observed([room], stamp)),
          }),
        },
        clock,
      );
      const listed = await operations.listRooms(authorization);
      assert.equal(listed.status, "listed");
      if (listed.status !== "listed") throw new Error("unreachable");
      assert.equal(listed.observed_at, stamp);
      assert.equal(listed.stale, true, stamp);
    }
  });

  it("annotates sieve.projection events with serve-time freshness and leaves other kinds untouched", async () => {
    const sieveEvent = {
      ...eventAt(5),
      kind: "sieve.projection",
      payload: {
        observed_at: "2026-09-19T11:59:50.000Z",
        source: "sieve:8899/dashboard/data",
        digest: "sha256:abc",
        stale_after_ms: 15_000,
      },
    };
    const agedSieveEvent = {
      ...eventAt(4),
      kind: "sieve.projection",
      payload: {
        observed_at: "2026-09-19T11:00:00.000Z",
        source: "sieve:8899/dashboard/data",
        digest: "sha256:def",
        stale_after_ms: 15_000,
      },
    };
    const operations = createPublicOperations(
      unusedRepository(),
      {
        ...baseCapabilities(),
        roomAuthority: sourceFor({
          replayEvents: () =>
            Promise.resolve(
              observed<RoomEventPage>({
                room,
                latestSeq: 5,
                events: [eventAt(3), agedSieveEvent, sieveEvent],
              }),
            ),
        }),
      },
      clock,
    );

    const page = await operations.replayRoomEvents(authorization, {
      roomId: ROOM_ID,
      after: 0,
      limit: 10,
    });
    assert.equal(page.status, "ok");
    if (page.status !== "ok") throw new Error("unreachable");

    const [plain, aged, fresh] = page.events;
    assert.equal(plain?.freshness, undefined);
    assert.deepEqual(aged?.freshness, {
      observed_at: "2026-09-19T11:00:00.000Z",
      stale: true,
    });
    assert.deepEqual(fresh?.freshness, {
      observed_at: "2026-09-19T11:59:50.000Z",
      stale: false,
    });
  });

  it("marks sieve.projection events stale when the freshness contract is unparseable", async () => {
    const missing = { ...eventAt(4), kind: "sieve.projection", payload: { source: "sieve" } };
    const badStamp = {
      ...eventAt(5),
      kind: "sieve.projection",
      payload: { observed_at: "nonsense", stale_after_ms: 1000 },
    };
    const noBudget = {
      ...eventAt(6),
      kind: "sieve.projection",
      payload: { observed_at: "2026-09-19T11:59:59.000Z" },
    };
    const operations = createPublicOperations(
      unusedRepository(),
      {
        ...baseCapabilities(),
        roomAuthority: sourceFor({
          replayEvents: () =>
            Promise.resolve(
              observed<RoomEventPage>({
                room,
                latestSeq: 6,
                events: [missing, badStamp, noBudget],
              }),
            ),
        }),
      },
      clock,
    );

    const page = await operations.replayRoomEvents(authorization, {
      roomId: ROOM_ID,
      after: 0,
      limit: 10,
    });
    if (page.status !== "ok") throw new Error("unreachable");
    assert.deepEqual(page.events[0]?.freshness, { observed_at: null, stale: true });
    assert.deepEqual(page.events[1]?.freshness, { observed_at: null, stale: true });
    assert.deepEqual(page.events[2]?.freshness, {
      observed_at: "2026-09-19T11:59:59.000Z",
      stale: true,
    });
  });
});

function eventAt(seq: number): ProjectedRoomEvent {
  return {
    event_id: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
    room_id: ROOM_ID,
    room_seq: seq,
    kind: "message",
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
    staleAfterMs: 30_000,
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

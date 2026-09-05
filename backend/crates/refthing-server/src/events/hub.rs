//! Per-board broadcast rooms for the WebSocket layer.
//!
//! `BroadcastHub` maps `board_id → broadcast::Sender` (capacity
//! [`ROOM_CAPACITY`], created on first subscribe). Each WS connection reads
//! its own `Receiver` in a dedicated outbound task, so a slow client can never
//! block the room; a `RecvError::Lagged` receiver is told to
//! [`ServerMsg::Resync`] and catches up via `/changes` — the socket stays up.
//! Rooms are garbage-collected when a broadcast finds the last receiver gone.

use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::dto::ops::BatchOp;

/// Ring buffer per room. A client more than this many messages behind gets a
/// `resync` instead of the missed diffs.
pub const ROOM_CAPACITY: usize = 256;

/// Server→client WS envelope. Client→server messages reuse the REST
/// [`crate::dto::ops::BatchRequest`] body verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// First message after upgrade: current seq, so the client knows its base.
    Hello {
        board_id: Uuid,
        seq: i64,
        /// Epoch milliseconds.
        server_time: i64,
    },
    /// A committed board mutation. `ops` are the same `BatchOp` shapes as the
    /// REST batch. `origin` is the mutating client's id — that client ignores
    /// its own diffs (its state is already optimistic).
    Diff {
        board_id: Uuid,
        seq: i64,
        origin: Option<String>,
        ops: Vec<BatchOp>,
    },
    /// This receiver lagged past the ring buffer; refetch `/changes?since=`.
    Resync { seq: i64 },
    /// Background job progress, e.g. `{type:"job", kind:"poster_ready",
    /// payload:{item_id, sizes}}`. `payload` is per-kind and forward-extensible.
    Job {
        kind: String,
        payload: serde_json::Value,
    },
}

/// Cheap to clone: clones share the same room map.
#[derive(Clone, Default)]
pub struct BroadcastHub {
    rooms: Arc<DashMap<Uuid, broadcast::Sender<Arc<ServerMsg>>>>,
}

impl BroadcastHub {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribes to `board_id`'s room, creating it on first use.
    #[must_use]
    pub fn subscribe(&self, board_id: Uuid) -> broadcast::Receiver<Arc<ServerMsg>> {
        self.rooms
            .entry(board_id)
            .or_insert_with(|| broadcast::channel(ROOM_CAPACITY).0)
            .subscribe()
    }

    /// Broadcasts to `board_id`'s room. No-op when no room exists. When the
    /// last receiver has dropped, the room is removed (recreated on the next
    /// subscribe), keeping the map bounded by live connections.
    pub fn broadcast(&self, board_id: Uuid, msg: ServerMsg) {
        let Some(sender) = self.rooms.get(&board_id) else {
            return;
        };
        // SendError means zero receivers — not an error worth reporting.
        drop(sender.send(Arc::new(msg)));
        let stale = sender.receiver_count() == 0;
        drop(sender);
        if stale {
            // Re-check under the write lock: a concurrent subscribe since the
            // count check keeps the room alive.
            self.rooms
                .remove_if(&board_id, |_, s| s.receiver_count() == 0);
        }
    }

    /// Number of live rooms; exposed for tests and the health endpoint.
    #[must_use]
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn job_msg() -> ServerMsg {
        ServerMsg::Job {
            kind: "poster_ready".to_string(),
            payload: json!({"item_id": Uuid::now_v7(), "sizes": [64, 256, 1024]}),
        }
    }

    #[test]
    fn server_msg_envelope_shapes() {
        let board_id = Uuid::now_v7();
        let hello = serde_json::to_value(ServerMsg::Hello {
            board_id,
            seq: 42,
            server_time: 1_700_000_000_000,
        })
        .expect("serialize");
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["seq"], 42);

        let resync = serde_json::to_value(ServerMsg::Resync { seq: 57 }).expect("serialize");
        assert_eq!(resync["type"], "resync");

        let diff = serde_json::to_value(ServerMsg::Diff {
            board_id,
            seq: 43,
            origin: Some("c1".to_string()),
            ops: vec![],
        })
        .expect("serialize");
        assert_eq!(diff["type"], "diff");
        assert_eq!(diff["origin"], "c1");
    }

    #[test]
    fn server_msg_round_trip() {
        let msg = job_msg();
        let json = serde_json::to_string(&msg).expect("serialize");
        let parsed: ServerMsg = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(msg, parsed);
    }

    #[tokio::test]
    async fn subscribe_then_broadcast_delivers() {
        let hub = BroadcastHub::new();
        let board_id = Uuid::now_v7();
        let mut rx = hub.subscribe(board_id);
        assert_eq!(hub.room_count(), 1);

        let msg = job_msg();
        hub.broadcast(board_id, msg.clone());
        let received = rx.recv().await.expect("receive");
        assert_eq!(*received, msg);
    }

    #[tokio::test]
    async fn rooms_are_isolated_per_board() {
        let hub = BroadcastHub::new();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let mut rx_a = hub.subscribe(a);
        let mut rx_b = hub.subscribe(b);

        hub.broadcast(a, job_msg());
        rx_a.recv().await.expect("a receives");
        assert!(rx_b.try_recv().is_err(), "b receives nothing");
    }

    #[tokio::test]
    async fn room_is_garbage_collected_after_last_receiver_drops() {
        let hub = BroadcastHub::new();
        let board_id = Uuid::now_v7();
        let rx = hub.subscribe(board_id);
        assert_eq!(hub.room_count(), 1);

        drop(rx);
        hub.broadcast(board_id, job_msg());
        assert_eq!(hub.room_count(), 0);

        // Room is recreated transparently on the next subscribe.
        let _rx = hub.subscribe(board_id);
        assert_eq!(hub.room_count(), 1);
    }

    #[tokio::test]
    async fn broadcast_without_room_is_noop() {
        let hub = BroadcastHub::new();
        hub.broadcast(Uuid::now_v7(), job_msg());
        assert_eq!(hub.room_count(), 0);
    }
}

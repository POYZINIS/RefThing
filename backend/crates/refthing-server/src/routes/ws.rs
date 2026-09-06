//! WebSocket endpoint: `GET /api/boards/{id}/ws?client_id={uuid}&since={seq?}`.
//!
//! On upgrade the client gets [`ServerMsg::Hello`] with the board's current
//! seq, then every committed mutation as [`ServerMsg::Diff`]. Gaps are NOT
//! replayed here — a client behind its cursor refetches
//! `/api/boards/{id}/changes?since=` over REST, and a receiver that lags past
//! the room ring buffer gets [`ServerMsg::Resync`] instead of a dropped
//! socket.
//!
//! Client→server frames are JSON [`BatchRequest`] bodies, applied through the
//! same [`item_service::apply_batch`] machinery as the REST batch endpoint.
//! That machinery broadcasts the diff itself, so this module never broadcasts.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::Response;
use axum::{Router, routing::get};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use uuid::Uuid;

use crate::dto::ops::BatchRequest;
use crate::error::{AppError, AppResult};
use crate::events::hub::ServerMsg;
use crate::services::item_service;
use crate::state::AppState;

/// Frames produced off the broadcast path (hello, per-request errors) queue
/// here so exactly one task ever writes the socket.
const OUTBOUND_QUEUE: usize = 32;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/boards/{id}/ws", get(ws_upgrade))
}

#[derive(Debug, Deserialize)]
struct WsParams {
    client_id: Uuid,
    /// The client's event-log cursor. Gaps between `since` and the hello seq
    /// are recovered via REST `/changes`; here it is only traced.
    since: Option<i64>,
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Path(board_id): Path<Uuid>,
    Query(params): Query<WsParams>,
    State(state): State<AppState>,
) -> AppResult<Response> {
    // Subscribe BEFORE reading seq: a mutation committed between the two then
    // lands in this receiver's ring buffer instead of being silently skipped,
    // so a client whose cursor equals the hello seq is genuinely current.
    let room = state.hub.subscribe(board_id);
    let board = refthing_core::db::boards::get(&state.pools.read, board_id)
        .await?
        .ok_or(AppError::NotFound("board"))?;
    if let Some(since) = params.since.filter(|since| *since < board.seq) {
        tracing::debug!(%board_id, since, seq = board.seq, "ws client behind; catches up via /changes");
    }
    let seq = board.seq;
    let client_id = params.client_id;
    Ok(ws.on_upgrade(move |socket| handle_socket(state, socket, board_id, seq, client_id, room)))
}

async fn handle_socket(
    state: AppState,
    socket: WebSocket,
    board_id: Uuid,
    seq: i64,
    client_id: Uuid,
    room: broadcast::Receiver<Arc<ServerMsg>>,
) {
    let (sender, inbound) = socket.split();
    let (out_tx, out_rx) = mpsc::channel::<Message>(OUTBOUND_QUEUE);
    let outbound = tokio::spawn(outbound_loop(
        state.clone(),
        board_id,
        seq,
        room,
        out_rx,
        sender,
    ));

    read_inbound(&state, board_id, client_id, inbound, &out_tx).await;

    // Client gone (or the read side errored): closing the channel ends the
    // outbound task, which drops the last sender half of the socket.
    drop(out_tx);
    if let Err(error) = outbound.await {
        tracing::debug!(%board_id, %client_id, %error, "ws outbound task join");
    }
}

/// Client→server frames: JSON [`BatchRequest`] bodies. Success is announced by
/// the batch machinery's own broadcast; failures go back as an error frame.
async fn read_inbound(
    state: &AppState,
    board_id: Uuid,
    client_id: Uuid,
    mut inbound: SplitStream<WebSocket>,
    out_tx: &mpsc::Sender<Message>,
) {
    while let Some(frame) = inbound.next().await {
        let result = match frame {
            Ok(Message::Text(text)) => match serde_json::from_str::<BatchRequest>(&text) {
                Ok(req) => item_service::apply_batch(state, board_id, req)
                    .await
                    .map(|_response| ()),
                Err(error) => Err(AppError::BadRequest(format!(
                    "invalid batch frame: {error}"
                ))),
            },
            Ok(Message::Binary(_)) => Err(AppError::BadRequest(
                "binary frames are not supported; send a JSON batch".to_string(),
            )),
            Ok(Message::Close(_)) => break,
            // axum answers pings automatically; pongs need no handling.
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            Err(error) => {
                tracing::debug!(%board_id, %client_id, %error, "ws receive error");
                break;
            }
        };
        if let Err(error) = result {
            tracing::debug!(%board_id, %client_id, %error, "ws batch rejected");
            if out_tx
                .send(Message::text(error_frame(&error)))
                .await
                .is_err()
            {
                break; // socket already gone
            }
        }
    }
}

/// The only writer of the socket: hello first, then room traffic interleaved
/// with queued local frames. A lagging receiver is told to resync (the socket
/// stays up); a dead room or a closed queue ends the task.
async fn outbound_loop(
    state: AppState,
    board_id: Uuid,
    seq: i64,
    room: broadcast::Receiver<Arc<ServerMsg>>,
    mut out_rx: mpsc::Receiver<Message>,
    mut sender: SplitSink<WebSocket, Message>,
) {
    let hello = ServerMsg::Hello {
        board_id,
        seq,
        server_time: chrono::Utc::now().timestamp_millis(),
    };
    if send_msg(&mut sender, &hello).await.is_err() {
        return;
    }

    let mut room = BroadcastStream::new(room);
    loop {
        let message = tokio::select! {
            local = out_rx.recv() => match local {
                Some(message) => Some(message),
                None => break, // inbound side finished
            },
            item = room.next() => match item {
                Some(Ok(msg)) => msg_to_frame(&msg),
                Some(Err(BroadcastStreamRecvError::Lagged(skipped))) => {
                    tracing::warn!(%board_id, skipped, "ws receiver lagged; sending resync");
                    let current = current_seq(&state, board_id).await.unwrap_or(seq);
                    msg_to_frame(&ServerMsg::Resync { seq: current })
                }
                None => break, // room sender dropped (hub GC)
            },
        };
        let Some(message) = message else {
            continue; // an unserializable frame: logged in msg_to_frame
        };
        if sender.send(message).await.is_err() {
            break; // client disconnected
        }
    }
}

fn msg_to_frame(msg: &ServerMsg) -> Option<Message> {
    match serde_json::to_string(msg) {
        Ok(json) => Some(Message::text(json)),
        Err(error) => {
            tracing::error!(%error, "failed to serialize server message");
            None
        }
    }
}

async fn send_msg(sender: &mut SplitSink<WebSocket, Message>, msg: &ServerMsg) -> AppResult<()> {
    let Some(message) = msg_to_frame(msg) else {
        return Ok(());
    };
    sender
        .send(message)
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))
}

/// Current board seq for a `resync` frame; `None` when the board is gone.
async fn current_seq(state: &AppState, board_id: Uuid) -> Option<i64> {
    let row = sqlx::query("SELECT seq FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_optional(&state.pools.read)
        .await
        .ok()??;
    sqlx::Row::try_get(&row, "seq").ok()
}

/// `{type:"error", code, message}` — mirrors the REST error envelope so the
/// client has one error shape across transports. `Conflict` here is always a
/// stale `base_seq`, so it carries the batch contract's `seq_conflict` code.
fn error_frame(error: &AppError) -> String {
    let code = match error {
        AppError::NotFound(_) => "not_found",
        AppError::Conflict(_) => "seq_conflict",
        AppError::BadRequest(_) => "bad_request",
        AppError::TooLarge => "too_large",
        AppError::UnsupportedMedia(_) => "unsupported_media",
        AppError::Unauthorized => "unauthorized",
        AppError::Db(_) | AppError::Core(_) | AppError::Io(_) => "internal",
    };
    serde_json::json!({"type": "error", "code": code, "message": error.to_string()}).to_string()
}

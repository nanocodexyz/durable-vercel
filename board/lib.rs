use std::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, Waker},
};

use nanocode_board::{
    Board, BoardError, Change, EventId, Fold, NewTask, Op, Outcome, Phase,
    access::{Identity, Verifier},
};
use nanocode_durability_core::{Sql, SqlRow, SqlStatement, StoreError, StoreFuture};
use nanocode_turnlog::SqlLog;
use serde::Deserialize;
use serde_json::{Value, json};

type Running = Pin<Box<dyn Future<Output = Value>>>;

thread_local! {
    static BOARD: RefCell<Option<Board>> = const { RefCell::new(None) };
    static RUNNING: RefCell<Option<Running>> = const { RefCell::new(None) };
    static REQUEST: RefCell<Option<String>> = const { RefCell::new(None) };
    static RESPONSE: RefCell<Option<Result<Vec<Vec<SqlRow>>, String>>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

pub struct JsSql;

pub struct Trusted;

impl Verifier for Trusted {
    fn verify(&self, credential: &str) -> Option<String> {
        Some(credential.to_owned())
    }
}

fn identity(actor: &str) -> Result<Identity, Value> {
    let (principal, profile) = actor.split_once('+').map_or((actor, None), |(principal, profile)| (principal, Some(profile)));
    let verified = Identity::verify(&Trusted, principal).map_err(|denied| json!({ "error": format!("{actor} is not an actor: {denied:?}") }))?;
    match profile {
        Some(name) => verified.profile(name).map_err(|denied| json!({ "error": format!("{actor} is not an actor: {denied:?}") })),
        None => Ok(verified),
    }
}

struct HostCall {
    request: Option<String>,
}

impl Future for HostCall {
    type Output = Result<Vec<Vec<SqlRow>>, StoreError>;

    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(request) = self.request.take() {
            REQUEST.with(|slot| *slot.borrow_mut() = Some(request));
            return Poll::Pending;
        }
        match RESPONSE.with(|slot| slot.borrow_mut().take()) {
            Some(response) => Poll::Ready(response.map_err(StoreError::Backend)),
            None => Poll::Pending,
        }
    }
}

impl Sql for JsSql {
    fn transaction<'a>(
        &'a self,
        operation: &'static str,
        statements: &'a [SqlStatement<'a>],
    ) -> StoreFuture<'a, Result<Vec<Vec<SqlRow>>, StoreError>> {
        let request = json!({ "operation": operation, "statements": statements }).to_string();
        Box::pin(HostCall { request: Some(request) })
    }
}

#[derive(Deserialize)]
#[serde(tag = "call", rename_all = "snake_case")]
enum Call {
    Open { scope: String, actor: String },
    Submit { key: String, at_ms: u64, op: Op },
    Refresh,
    View { at_ms: u64 },
    Entries { after: u64 },
    Outcome { actor: String, key: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Response {
    Rows(Vec<Vec<Vec<Value>>>),
    Error(String),
}

fn cell(value: Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text),
        other => Some(other.to_string()),
    }
}

fn failure(error: &BoardError) -> Value {
    match error {
        BoardError::Rejected(rejection) => json!({ "rejected": format!("{rejection:?}") }),
        BoardError::Unsettled { event, error } => json!({ "unsettled": event.0, "error": error.to_string() }),
        other => json!({ "error": other.to_string() }),
    }
}

fn with_board<T>(f: impl FnOnce(&Board) -> T) -> Result<T, Value> {
    BOARD.with(|slot| slot.borrow().as_ref().map(f).ok_or_else(|| json!({ "error": "the board is not open" })))
}

fn run(future: impl Future<Output = Value> + 'static) -> u32 {
    RUNNING.with(|slot| *slot.borrow_mut() = Some(Box::pin(future)));
    poll()
}

fn poll() -> u32 {
    let mut context = Context::from_waker(Waker::noop());
    let mut running = RUNNING.with(|slot| slot.borrow_mut().take());
    let Some(future) = running.as_mut() else {
        return finish(json!({ "error": "no call is running" }));
    };
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => finish(value),
        Poll::Pending => {
            RUNNING.with(|slot| *slot.borrow_mut() = running);
            let request = REQUEST.with(|slot| slot.borrow_mut().take()).unwrap_or_else(|| "null".to_owned());
            write_out(request.into_bytes());
            1
        }
    }
}

fn finish(value: Value) -> u32 {
    write_out(value.to_string().into_bytes());
    0
}

fn write_out(bytes: Vec<u8>) {
    OUT.with(|out| *out.borrow_mut() = bytes);
}

fn take_board() -> Option<Board> {
    BOARD.with(|slot| slot.borrow_mut().take())
}

fn put_board(board: Board) {
    BOARD.with(|slot| *slot.borrow_mut() = Some(board));
}

fn phase(phase: &Phase) -> Value {
    match phase {
        Phase::Open => json!({ "state": "open" }),
        Phase::Claimed { claim, worker, until_ms } => json!({ "state": "claimed", "claim": claim.0, "worker": worker, "until_ms": until_ms }),
        Phase::Done { result } => json!({ "state": "done", "result": result }),
        Phase::Failed { error } => json!({ "state": "failed", "error": error }),
        Phase::Cancelled { reason } => json!({ "state": "cancelled", "reason": reason }),
    }
}

fn outcome(outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Done(detail) => json!({ "kind": "done", "detail": detail }),
        Outcome::Failed(detail) => json!({ "kind": "failed", "detail": detail }),
    }
}

fn change(change: &Change) -> Value {
    match change {
        Change::Posted => json!({ "kind": "posted" }),
        Change::Claimed { claim, worker, until_ms, took_over } => json!({ "kind": "claimed", "claim": claim.0, "worker": worker, "until_ms": until_ms, "took_over": took_over.as_ref().map(|claim| claim.0.clone()) }),
        Change::Renewed { claim, until_ms } => json!({ "kind": "renewed", "claim": claim.0, "until_ms": until_ms }),
        Change::Released { claim, note } => json!({ "kind": "released", "claim": claim.0, "note": note }),
        Change::Finished(finished) => json!({ "kind": "finished", "outcome": outcome(finished) }),
        Change::Cancelled { reason } => json!({ "kind": "cancelled", "reason": reason }),
        Change::Replied { by, body } => json!({ "kind": "replied", "by": by, "body": body }),
    }
}

fn spec(task: &NewTask) -> Value {
    json!({ "id": task.id.0, "parent": task.parent.as_ref().map(|parent| parent.0.clone()), "spec": task.spec, "labels": task.labels, "needs": task.needs.iter().map(|need| need.0.clone()).collect::<Vec<_>>() })
}

pub fn view(fold: &Fold, at_ms: u64) -> Value {
    let tasks = fold.tasks().values().map(|task| {
        let mut value = spec(&task.spec);
        value["phase"] = phase(&task.phase);
        value["attempts"] = json!(task.attempts);
        value["replies"] = json!(task.replies.iter().map(|(by, body)| json!({ "by": by, "body": body })).collect::<Vec<_>>());
        value
    }).collect::<Vec<_>>();
    json!({ "next": fold.next(), "now_ms": fold.now_ms(), "settled": fold.settled(), "ready": fold.ready(at_ms).map(|id| id.0.clone()).collect::<Vec<_>>(), "tasks": tasks })
}

pub fn entries(fold: &Fold, after: u64) -> Value {
    json!(fold.entries().iter().filter(|entry| entry.seq > after).map(|entry| json!({ "seq": entry.seq, "event": entry.event.0, "at_ms": entry.at_ms, "task": entry.task.0, "change": change(&entry.change) })).collect::<Vec<_>>())
}

fn call(input: &[u8]) -> u32 {
    let call = match serde_json::from_slice::<Call>(input) {
        Ok(call) => call,
        Err(error) => return finish(json!({ "error": format!("bad call: {error}") })),
    };
    match call {
        Call::Open { scope, actor } => run(async move {
            let identity = match identity(&actor) {
                Ok(identity) => identity,
                Err(error) => return error,
            };
            match Board::open(Arc::new(SqlLog::new(Arc::new(JsSql))), &scope, identity).await {
                Ok(board) => {
                    let next = board.fold().next();
                    put_board(board);
                    json!({ "ok": { "next": next } })
                }
                Err(error) => failure(&error),
            }
        }),
        Call::Submit { key, at_ms, op } => {
            let Some(mut board) = take_board() else { return finish(json!({ "error": "the board is not open" })) };
            run(async move {
                let applied = board.submit_keyed(&key, at_ms, op).await;
                put_board(board);
                match applied {
                    Ok(applied) => json!({ "ok": { "seq": applied.seq, "event": applied.event.0 } }),
                    Err(error) => failure(&error),
                }
            })
        }
        Call::Refresh => {
            let Some(mut board) = take_board() else { return finish(json!({ "error": "the board is not open" })) };
            run(async move {
                let refreshed = board.refresh().await;
                let next = board.fold().next();
                put_board(board);
                refreshed.map_or_else(|error| failure(&error), |()| json!({ "ok": { "next": next } }))
            })
        }
        Call::View { at_ms } => finish(with_board(|board| json!({ "ok": view(board.fold(), at_ms) })).unwrap_or_else(|error| error)),
        Call::Entries { after } => finish(with_board(|board| json!({ "ok": entries(board.fold(), after) })).unwrap_or_else(|error| error)),
        Call::Outcome { actor, key } => finish(with_board(|board| json!({ "ok": board.fold().outcome(&EventId(format!("{actor}#{key}"))).map(|verdict| match verdict {
            Ok(seq) => json!({ "seq": seq }),
            Err(rejection) => json!({ "rejected": format!("{rejection:?}") }),
        }) })).unwrap_or_else(|error| error)),
    }
}

fn resumed(input: &[u8]) -> u32 {
    let response = match serde_json::from_slice::<Response>(input) {
        Ok(Response::Rows(results)) => Ok(results.into_iter().map(|rows| rows.into_iter().map(|row| row.into_iter().map(cell).collect()).collect()).collect()),
        Ok(Response::Error(message)) => Err(message),
        Err(error) => Err(format!("bad response: {error}")),
    };
    RESPONSE.with(|slot| *slot.borrow_mut() = Some(response));
    poll()
}

fn abandon() {
    RUNNING.with(|slot| slot.borrow_mut().take());
    REQUEST.with(|slot| slot.borrow_mut().take());
    RESPONSE.with(|slot| slot.borrow_mut().take());
}

#[cfg(target_arch = "wasm32")]
mod exports {
    use std::alloc::{Layout, alloc, dealloc};

    fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
        if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn board_alloc(len: usize) -> *mut u8 {
        unsafe { alloc(Layout::from_size_align(len.max(1), 1).unwrap()) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn board_free(ptr: *mut u8, len: usize) {
        unsafe { dealloc(ptr, Layout::from_size_align(len.max(1), 1).unwrap()) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn board_call(ptr: *const u8, len: usize) -> u32 {
        super::call(bytes(ptr, len))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn board_resume(ptr: *const u8, len: usize) -> u32 {
        super::resumed(bytes(ptr, len))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn board_abandon() {
        super::abandon();
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn board_out_ptr() -> *const u8 {
        super::OUT.with(|out| out.borrow().as_ptr())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn board_out_len() -> usize {
        super::OUT.with(|out| out.borrow().len())
    }
}

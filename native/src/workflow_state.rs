//! Pull workflow snapshots use the existing lease-fenced entity state RPCs.
use super::Worker;
use agnt5_sdk_core::client::WorkerCoordinatorClient;
use agnt5_sdk_core::pb::{GetEntityStateRequest, PutEntityStateRequest};
use napi::{Error, Result};
use napi_derive::napi;
use std::collections::HashMap;
use tokio::sync::Mutex;

#[napi(object)]
pub struct WorkflowStateSnapshot {
    pub run_id: String,
    pub metadata: HashMap<String, String>,
    pub state_json: String,
}

#[derive(Default)]
pub(crate) struct WorkflowStateSink {
    client: Mutex<Option<WorkerCoordinatorClient>>,
}

impl WorkflowStateSink {
    async fn persist(&self, endpoint: &str, snapshot: WorkflowStateSnapshot) -> Result<()> {
        let (read, mut write) = snapshot_requests(snapshot)?;
        let mut client = {
            let mut guard = self.client.lock().await;
            if guard.is_none() {
                *guard = Some(
                    WorkerCoordinatorClient::connect(endpoint.to_string())
                        .await
                        .map_err(|e| Error::from_reason(e.to_string()))?,
                );
            }
            // Do not serialize unrelated runs behind a network wait.
            guard.as_ref().expect("state client initialized").clone()
        };
        let current = client
            .get_entity_state(read)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        write.expected_version = current.version;
        client
            .put_entity_state(write)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(())
    }
}

#[napi]
impl Worker {
    /// Acknowledge a final workflow snapshot before reporting completion.
    #[napi]
    pub async fn persist_workflow_state(&self, snapshot: WorkflowStateSnapshot) -> Result<()> {
        self.workflow_state
            .persist(&self.config.coordinator_endpoint, snapshot)
            .await
    }
}

fn snapshot_requests(
    snapshot: WorkflowStateSnapshot,
) -> Result<(GetEntityStateRequest, PutEntityStateRequest)> {
    let required = |key: &str| -> Result<String> {
        snapshot
            .metadata
            .get(key)
            .filter(|v| !v.is_empty())
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("Workflow state requires {key}")))
    };
    if snapshot.run_id.is_empty() || required("dispatch_mode")? != "pull" {
        return Err(Error::from_reason(
            "Workflow state requires an active pull run",
        ));
    }
    let attempt = required("lease_attempt")?
        .parse::<u32>()
        .map_err(|_| Error::from_reason("Workflow state requires a valid lease_attempt"))?;
    let state: serde_json::Value = serde_json::from_str(&snapshot.state_json)
        .map_err(|_| Error::from_reason("Workflow state must be valid JSON"))?;
    if !state.is_object() {
        return Err(Error::from_reason("Workflow state must be a JSON object"));
    }
    // Same scope priority and entity keys as Python's WorkflowEntity.
    let (scope, scope_id, entity_key) =
        if let Some(user) = snapshot.metadata.get("user_id").filter(|v| !v.is_empty()) {
            ("user", user.clone(), format!("user:{user}"))
        } else if let Some(session) = snapshot
            .metadata
            .get("session_id")
            .filter(|v| !v.is_empty() && *v != &snapshot.run_id)
        {
            let key = match snapshot
                .metadata
                .get("component_name")
                .filter(|v| !v.is_empty())
            {
                Some(component) => format!("workflow:{component}:session:{session}"),
                None => format!("session:{session}"),
            };
            ("session", session.clone(), key)
        } else {
            (
                "run",
                snapshot.run_id.clone(),
                format!("run:{}", snapshot.run_id),
            )
        };
    let read = GetEntityStateRequest {
        project_id: required("project_id")?,
        entity_type: "WorkflowEntity".into(),
        entity_key,
        scope: scope.into(),
        scope_id,
    };
    let write = PutEntityStateRequest {
        project_id: read.project_id.clone(),
        entity_type: read.entity_type.clone(),
        entity_key: read.entity_key.clone(),
        scope: read.scope.clone(),
        scope_id: read.scope_id.clone(),
        state_json: snapshot.state_json.as_bytes().to_vec(),
        expected_version: 0,
        worker_id: required("worker_id")?,
        worker_session_id: required("worker_session_id")?,
        lease_id: required("lease_id")?,
        attempt: Some(attempt),
        run_id: snapshot.run_id.clone(),
        operation_id: uuid::Uuid::new_v4().to_string(),
    };
    Ok((read, write))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> WorkflowStateSnapshot {
        WorkflowStateSnapshot {
            run_id: "run-1".into(),
            state_json: r#"{"order.stage":"receipted"}"#.into(),
            metadata: [
                ("project_id", "project-1"),
                ("dispatch_mode", "pull"),
                ("worker_id", "worker-1"),
                ("worker_session_id", "session-1"),
                ("lease_id", "lease-1"),
                ("lease_attempt", "2"),
                ("component_name", "ks_process_order"),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect(),
        }
    }

    #[test]
    fn snapshot_is_scoped_and_lease_fenced() {
        let (read, write) = snapshot_requests(snapshot()).unwrap();
        assert_eq!(read.entity_type, "WorkflowEntity");
        assert_eq!(read.entity_key, "run:run-1");
        assert_eq!(read.scope_id, "run-1");
        assert_eq!(write.project_id, "project-1");
        assert_eq!(write.worker_id, "worker-1");
        assert_eq!(write.worker_session_id, "session-1");
        assert_eq!(write.lease_id, "lease-1");
        assert_eq!(write.attempt, Some(2));
        assert!(!write.operation_id.is_empty());
        assert_ne!(
            write.operation_id,
            snapshot_requests(snapshot()).unwrap().1.operation_id
        );
    }

    #[test]
    fn scope_priority_matches_python() {
        let mut s = snapshot();
        s.metadata
            .insert("session_id".into(), "conversation".into());
        let (read, _) = snapshot_requests(s).unwrap();
        assert_eq!(read.scope, "session");
        assert_eq!(
            read.entity_key,
            "workflow:ks_process_order:session:conversation"
        );
        let mut s = snapshot();
        s.metadata
            .insert("session_id".into(), "conversation".into());
        s.metadata.insert("user_id".into(), "customer".into());
        let (read, _) = snapshot_requests(s).unwrap();
        assert_eq!(read.scope, "user");
        assert_eq!(read.entity_key, "user:customer");
    }

    #[test]
    fn missing_authority_fails_before_any_write() {
        for key in [
            "project_id",
            "dispatch_mode",
            "worker_id",
            "worker_session_id",
            "lease_id",
            "lease_attempt",
        ] {
            let mut s = snapshot();
            s.metadata.remove(key);
            assert!(snapshot_requests(s).is_err(), "accepted missing {key}");
        }
        let mut s = snapshot();
        s.metadata.insert("lease_attempt".into(), "invalid".into());
        assert!(snapshot_requests(s).is_err());
    }
}

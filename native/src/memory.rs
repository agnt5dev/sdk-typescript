use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as TokioMutex;

// =============================================================================
// GraphMemory NAPI bindings
// =============================================================================

#[napi(object)]
#[derive(Clone)]
pub struct JsGraphNode {
    pub id: String,
    pub node_type: String,
    pub properties: HashMap<String, String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsGraphRelationship {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub relationship_type: String,
    pub properties: HashMap<String, String>,
    pub created_at: i64,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsGraphTraversalResult {
    pub start_node: String,
    pub nodes: Vec<JsGraphNode>,
    pub relationships: Vec<JsGraphRelationship>,
    pub depth: i32,
}

struct InMemoryGraph {
    nodes: HashMap<String, JsGraphNode>,
    relationships: HashMap<String, JsGraphRelationship>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// NAPI wrapper around a lightweight in-memory graph.
#[napi]
pub struct JsMemoryGraph {
    inner: Arc<TokioMutex<InMemoryGraph>>,
}

#[napi]
impl JsMemoryGraph {
    #[napi(constructor)]
    pub fn new(scope: String) -> Self {
        let _ = scope;
        JsMemoryGraph {
            inner: Arc::new(TokioMutex::new(InMemoryGraph {
                nodes: HashMap::new(),
                relationships: HashMap::new(),
            })),
        }
    }

    /// Upsert a node (create or update). Returns the node ID.
    #[napi]
    pub async fn upsert_node(
        &self,
        node_id: String,
        node_type: String,
        properties: Option<HashMap<String, String>>,
    ) -> Result<String> {
        let mut graph = self.inner.lock().await;
        graph.nodes.insert(
            node_id.clone(),
            JsGraphNode {
                id: node_id.clone(),
                node_type,
                properties: properties.unwrap_or_default(),
            },
        );
        Ok(node_id)
    }

    /// Get a node by ID.
    #[napi]
    pub async fn get_node(&self, node_id: String) -> Result<Option<JsGraphNode>> {
        let graph = self.inner.lock().await;
        Ok(graph.nodes.get(&node_id).cloned())
    }

    /// Delete a node by ID.
    #[napi]
    pub async fn delete_node(&self, node_id: String) -> Result<bool> {
        let mut graph = self.inner.lock().await;
        let removed_node = graph.nodes.remove(&node_id).is_some();
        graph
            .relationships
            .retain(|_, rel| rel.from_node != node_id && rel.to_node != node_id);
        Ok(removed_node)
    }

    /// Create a relationship between two nodes.
    #[napi]
    pub async fn create_relationship(
        &self,
        from_node: String,
        to_node: String,
        relationship_type: String,
        properties: Option<HashMap<String, String>>,
    ) -> Result<String> {
        let mut graph = self.inner.lock().await;
        if !graph.nodes.contains_key(&from_node) || !graph.nodes.contains_key(&to_node) {
            return Err(Error::from_reason(
                "create_relationship failed: missing node",
            ));
        }

        let relationship_id = format!("rel-{}", graph.relationships.len() + 1);
        graph.relationships.insert(
            relationship_id.clone(),
            JsGraphRelationship {
                id: relationship_id.clone(),
                from_node,
                to_node,
                relationship_type,
                properties: properties.unwrap_or_default(),
                created_at: now_millis(),
            },
        );
        Ok(relationship_id)
    }

    /// Query relationships with optional filters.
    #[napi]
    pub async fn query_relationships(
        &self,
        from_node: Option<String>,
        to_node: Option<String>,
        relationship_type: Option<String>,
        limit: Option<i32>,
    ) -> Result<Vec<JsGraphRelationship>> {
        let graph = self.inner.lock().await;
        let mut rels: Vec<JsGraphRelationship> = graph
            .relationships
            .values()
            .filter(|rel| {
                from_node
                    .as_ref()
                    .map(|v| &rel.from_node == v)
                    .unwrap_or(true)
            })
            .filter(|rel| to_node.as_ref().map(|v| &rel.to_node == v).unwrap_or(true))
            .filter(|rel| {
                relationship_type
                    .as_ref()
                    .map(|v| &rel.relationship_type == v)
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        rels.truncate(limit.map(|v| v.max(0) as usize).unwrap_or(100));
        Ok(rels)
    }

    /// Delete a relationship by ID.
    #[napi]
    pub async fn delete_relationship(&self, relationship_id: String) -> Result<bool> {
        let mut graph = self.inner.lock().await;
        Ok(graph.relationships.remove(&relationship_id).is_some())
    }

    /// Traverse the graph from a starting node.
    #[napi]
    pub async fn traverse(
        &self,
        start_node_id: String,
        max_depth: i32,
        relationship_types: Option<Vec<String>>,
        node_types: Option<Vec<String>>,
    ) -> Result<JsGraphTraversalResult> {
        let graph = self.inner.lock().await;
        if !graph.nodes.contains_key(&start_node_id) {
            return Err(Error::from_reason("traverse failed: start node not found"));
        }

        let max_depth = max_depth.max(0) as usize;
        let mut queue = std::collections::VecDeque::from([(start_node_id.clone(), 0usize)]);
        let mut visited = std::collections::HashSet::new();
        let mut nodes = Vec::new();
        let mut relationships = Vec::new();

        while let Some((node_id, depth)) = queue.pop_front() {
            if !visited.insert(node_id.clone()) {
                continue;
            }

            if let Some(node) = graph.nodes.get(&node_id) {
                if node_types
                    .as_ref()
                    .map(|types| types.contains(&node.node_type))
                    .unwrap_or(true)
                {
                    nodes.push(node.clone());
                }
            }

            if depth >= max_depth {
                continue;
            }

            for rel in graph.relationships.values() {
                let rel_allowed = relationship_types
                    .as_ref()
                    .map(|types| types.contains(&rel.relationship_type))
                    .unwrap_or(true);
                if !rel_allowed {
                    continue;
                }
                if rel.from_node == node_id {
                    relationships.push(rel.clone());
                    queue.push_back((rel.to_node.clone(), depth + 1));
                }
            }
        }

        Ok(JsGraphTraversalResult {
            start_node: start_node_id,
            nodes,
            relationships,
            depth: max_depth as i32,
        })
    }
}

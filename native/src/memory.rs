use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use std::time::{SystemTime, UNIX_EPOCH};

use agnt5_sdk_core::memory::{
    MemoryMetadata, MemoryResult as CoreMemoryResult, MemoryScope as CoreMemoryScope,
    SemanticMemory, SemanticMemoryConfig,
};

// =============================================================================
// SemanticMemory NAPI bindings
// =============================================================================

#[napi(object)]
pub struct JsMemoryMetadata {
    pub source: Option<String>,
    pub created_at: Option<String>,
    pub extra: Option<HashMap<String, String>>,
}

#[napi(object)]
pub struct JsMemoryResult {
    pub id: String,
    pub content: String,
    pub score: f64,
    pub source: Option<String>,
    pub created_at: Option<String>,
    pub extra: Option<HashMap<String, String>>,
}

impl From<CoreMemoryResult> for JsMemoryResult {
    fn from(r: CoreMemoryResult) -> Self {
        let extra: HashMap<String, String> = r
            .metadata
            .extra
            .into_iter()
            .map(|(k, v)| (k, v.to_string()))
            .collect();
        JsMemoryResult {
            id: r.id,
            content: r.content,
            score: r.score as f64,
            source: r.metadata.source,
            created_at: r.metadata.created_at,
            extra: if extra.is_empty() { None } else { Some(extra) },
        }
    }
}

fn js_metadata_to_core(meta: JsMemoryMetadata) -> MemoryMetadata {
    let mut m = MemoryMetadata::new();
    if let Some(s) = meta.source {
        m = m.with_source(s);
    }
    if let Some(c) = meta.created_at {
        m = m.with_created_at(c);
    }
    if let Some(extra) = meta.extra {
        for (k, v) in extra {
            m = m.with_extra(k, serde_json::Value::String(v));
        }
    }
    m
}

fn parse_scope(scope: &str) -> Result<CoreMemoryScope> {
    CoreMemoryScope::from_str(scope)
        .ok_or_else(|| Error::from_reason(format!("Invalid memory scope: {}", scope)))
}

/// NAPI wrapper around sdk-core SemanticMemory with real embeddings + vector DB.
#[napi]
pub struct JsSemanticMemory {
    inner: Arc<TokioMutex<Option<SemanticMemory>>>,
    scope: String,
    scope_id: String,
}

#[napi]
impl JsSemanticMemory {
    /// Create a SemanticMemory instance using environment-based auto-detection
    /// for the embedder and vector database.
    ///
    /// Env vars: OPENAI_API_KEY (embedder), QDRANT_URL / PINECONE_API_KEY / etc. (vectordb)
    #[napi(factory)]
    pub async fn from_env(scope: String, scope_id: String) -> Result<JsSemanticMemory> {
        let core_scope = parse_scope(&scope)?;
        let config = SemanticMemoryConfig::new(core_scope, scope_id.clone());

        let memory = SemanticMemory::from_env_with_config(config)
            .await
            .map_err(|e| Error::from_reason(format!("Failed to create SemanticMemory: {}", e)))?;

        Ok(JsSemanticMemory {
            inner: Arc::new(TokioMutex::new(Some(memory))),
            scope,
            scope_id,
        })
    }

    #[napi(getter)]
    pub fn scope(&self) -> String {
        self.scope.clone()
    }

    #[napi(getter)]
    pub fn scope_id(&self) -> String {
        self.scope_id.clone()
    }

    /// Store content and return its memory ID.
    #[napi]
    pub async fn store(&self, content: String) -> Result<String> {
        let guard = self.inner.lock().await;
        let mem = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("SemanticMemory not initialized"))?;
        mem.store(&content)
            .await
            .map_err(|e| Error::from_reason(format!("store failed: {}", e)))
    }

    /// Store content with metadata and return its memory ID.
    #[napi]
    pub async fn store_with_metadata(
        &self,
        content: String,
        metadata: JsMemoryMetadata,
    ) -> Result<String> {
        let guard = self.inner.lock().await;
        let mem = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("SemanticMemory not initialized"))?;
        let core_meta = js_metadata_to_core(metadata);
        mem.store_with_metadata(&content, core_meta)
            .await
            .map_err(|e| Error::from_reason(format!("store_with_metadata failed: {}", e)))
    }

    /// Search for similar memories.
    #[napi]
    pub async fn search(&self, query: String, limit: i32) -> Result<Vec<JsMemoryResult>> {
        let guard = self.inner.lock().await;
        let mem = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("SemanticMemory not initialized"))?;
        let results = mem
            .search(&query, limit as u32)
            .await
            .map_err(|e| Error::from_reason(format!("search failed: {}", e)))?;
        Ok(results.into_iter().map(JsMemoryResult::from).collect())
    }

    /// Search with minimum score threshold.
    #[napi]
    pub async fn search_with_options(
        &self,
        query: String,
        limit: i32,
        min_score: Option<f64>,
    ) -> Result<Vec<JsMemoryResult>> {
        let guard = self.inner.lock().await;
        let mem = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("SemanticMemory not initialized"))?;
        let results = mem
            .search_with_options(&query, limit as u32, min_score.map(|s| s as f32))
            .await
            .map_err(|e| Error::from_reason(format!("search_with_options failed: {}", e)))?;
        Ok(results.into_iter().map(JsMemoryResult::from).collect())
    }

    /// Delete a memory by ID.
    #[napi]
    pub async fn forget(&self, memory_id: String) -> Result<bool> {
        let guard = self.inner.lock().await;
        let mem = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("SemanticMemory not initialized"))?;
        mem.forget(&memory_id)
            .await
            .map_err(|e| Error::from_reason(format!("forget failed: {}", e)))
    }

    /// Retrieve a specific memory by ID.
    #[napi]
    pub async fn get(&self, memory_id: String) -> Result<Option<JsMemoryResult>> {
        let guard = self.inner.lock().await;
        let mem = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("SemanticMemory not initialized"))?;
        let result = mem
            .get(&memory_id)
            .await
            .map_err(|e| Error::from_reason(format!("get failed: {}", e)))?;
        Ok(result.map(JsMemoryResult::from))
    }
}

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
        graph.relationships.retain(|_, rel| rel.from_node != node_id && rel.to_node != node_id);
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
            return Err(Error::from_reason("create_relationship failed: missing node"));
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
            .filter(|rel| from_node.as_ref().map(|v| &rel.from_node == v).unwrap_or(true))
            .filter(|rel| to_node.as_ref().map(|v| &rel.to_node == v).unwrap_or(true))
            .filter(|rel| relationship_type.as_ref().map(|v| &rel.relationship_type == v).unwrap_or(true))
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
                if node_types.as_ref().map(|types| types.contains(&node.node_type)).unwrap_or(true) {
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

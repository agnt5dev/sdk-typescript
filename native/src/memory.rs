use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use agnt5_sdk_core::memory::{
    MemoryMetadata, MemoryResult as CoreMemoryResult, MemoryScope as CoreMemoryScope,
    SemanticMemory, SemanticMemoryConfig,
};
use agnt5_sdk_core::graph::{
    GraphDatabase, GraphNode as CoreGraphNode, GraphRelationship as CoreGraphRelationship,
    GraphTraversalResult as CoreGraphTraversalResult, RelationshipQuery, TraversalFilters,
};
use agnt5_sdk_core::MemoryGraphDatabase;

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
pub struct JsGraphNode {
    pub id: String,
    pub node_type: String,
    pub properties: HashMap<String, String>,
}

#[napi(object)]
pub struct JsGraphRelationship {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub relationship_type: String,
    pub properties: HashMap<String, String>,
    pub created_at: i64,
}

#[napi(object)]
pub struct JsGraphTraversalResult {
    pub start_node: String,
    pub nodes: Vec<JsGraphNode>,
    pub relationships: Vec<JsGraphRelationship>,
    pub depth: i32,
}

fn core_props_to_string(props: HashMap<String, serde_json::Value>) -> HashMap<String, String> {
    props.into_iter().map(|(k, v)| (k, v.to_string())).collect()
}

fn string_props_to_core(props: HashMap<String, String>) -> HashMap<String, serde_json::Value> {
    props.into_iter().map(|(k, v)| (k, serde_json::Value::String(v))).collect()
}

impl From<CoreGraphNode> for JsGraphNode {
    fn from(n: CoreGraphNode) -> Self {
        JsGraphNode {
            id: n.id,
            node_type: n.node_type,
            properties: core_props_to_string(n.properties),
        }
    }
}

impl From<CoreGraphRelationship> for JsGraphRelationship {
    fn from(r: CoreGraphRelationship) -> Self {
        JsGraphRelationship {
            id: r.id,
            from_node: r.from_node,
            to_node: r.to_node,
            relationship_type: r.relationship_type,
            properties: core_props_to_string(r.properties),
            created_at: r.created_at,
        }
    }
}

impl From<CoreGraphTraversalResult> for JsGraphTraversalResult {
    fn from(t: CoreGraphTraversalResult) -> Self {
        JsGraphTraversalResult {
            start_node: t.start_node,
            nodes: t.nodes.into_iter().map(JsGraphNode::from).collect(),
            relationships: t
                .relationships
                .into_iter()
                .map(JsGraphRelationship::from)
                .collect(),
            depth: t.depth as i32,
        }
    }
}

/// NAPI wrapper around sdk-core MemoryGraphDatabase (in-memory graph).
#[napi]
pub struct JsMemoryGraph {
    inner: Arc<MemoryGraphDatabase>,
}

#[napi]
impl JsMemoryGraph {
    #[napi(constructor)]
    pub fn new(scope: String) -> Self {
        JsMemoryGraph {
            inner: Arc::new(MemoryGraphDatabase::new(scope)),
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
        let core_props = properties.map(string_props_to_core).unwrap_or_default();
        self.inner
            .upsert_node(&node_id, &node_type, core_props)
            .await
            .map_err(|e| Error::from_reason(format!("upsert_node failed: {}", e)))
    }

    /// Get a node by ID.
    #[napi]
    pub async fn get_node(&self, node_id: String) -> Result<Option<JsGraphNode>> {
        let node = self
            .inner
            .get_node(&node_id)
            .await
            .map_err(|e| Error::from_reason(format!("get_node failed: {}", e)))?;
        Ok(node.map(JsGraphNode::from))
    }

    /// Delete a node by ID.
    #[napi]
    pub async fn delete_node(&self, node_id: String) -> Result<bool> {
        self.inner
            .delete_node(&node_id)
            .await
            .map_err(|e| Error::from_reason(format!("delete_node failed: {}", e)))
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
        let core_props = properties.map(string_props_to_core).unwrap_or_default();
        self.inner
            .create_relationship(&from_node, &to_node, &relationship_type, core_props)
            .await
            .map_err(|e| Error::from_reason(format!("create_relationship failed: {}", e)))
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
        let query = RelationshipQuery {
            from_node,
            to_node,
            relationship_type,
            limit: limit.map(|l| l as usize).unwrap_or(100),
        };
        let rels = self
            .inner
            .query_relationships(query)
            .await
            .map_err(|e| Error::from_reason(format!("query_relationships failed: {}", e)))?;
        Ok(rels.into_iter().map(JsGraphRelationship::from).collect())
    }

    /// Delete a relationship by ID.
    #[napi]
    pub async fn delete_relationship(&self, relationship_id: String) -> Result<bool> {
        self.inner
            .delete_relationship(&relationship_id)
            .await
            .map_err(|e| Error::from_reason(format!("delete_relationship failed: {}", e)))
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
        let filters = if relationship_types.is_some() || node_types.is_some() {
            Some(TraversalFilters {
                relationship_types,
                node_types,
            })
        } else {
            None
        };
        let result = self
            .inner
            .traverse(&start_node_id, max_depth as u32, filters)
            .await
            .map_err(|e| Error::from_reason(format!("traverse failed: {}", e)))?;
        Ok(JsGraphTraversalResult::from(result))
    }
}

use wasm_bindgen::prelude::*;

/// Worker for handling function invocations
#[wasm_bindgen]
pub struct Worker {
    service_name: String,
}

#[wasm_bindgen]
impl Worker {
    /// Create a new worker instance
    #[wasm_bindgen(constructor)]
    pub fn new(service_name: String) -> Worker {
        Worker { service_name }
    }

    /// Run the worker (starts listening for invocations)
    #[wasm_bindgen]
    pub async fn run(&self) -> Result<(), JsValue> {
        // TODO: Connect to agnt5-sdk-core worker implementation
        web_sys::console::log_1(&format!("Worker '{}' running (WASM binding)", self.service_name).into());
        Ok(())
    }
}

/// Execution context for functions
#[wasm_bindgen]
pub struct Context {
    run_id: String,
    attempt: u32,
}

#[wasm_bindgen]
impl Context {
    /// Create a new context
    #[wasm_bindgen(constructor)]
    pub fn new(run_id: String) -> Context {
        Context {
            run_id,
            attempt: 0,
        }
    }

    /// Get the run ID
    #[wasm_bindgen(getter)]
    pub fn run_id(&self) -> String {
        self.run_id.clone()
    }

    /// Get the current attempt number
    #[wasm_bindgen(getter)]
    pub fn attempt(&self) -> u32 {
        self.attempt
    }
}

/// Initialize the SDK (called automatically on module load)
#[wasm_bindgen(start)]
pub fn initialize() {
    // Set panic hook for better error messages in WASM
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

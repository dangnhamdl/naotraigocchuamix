/**
 * ============================================================================
 * NKTg AI SYSTEM MAIN ENTRY POINT
 * ============================================================================
 * Pipeline Loader: Step 1 → Step 9
 */
(async () => {
    try {
        console.log("[Kernel] Initializing core bootloader sequence...");
        
        // Step 1 phải load trước để cung cấp registerGeoRoutingHandler
        await import('./step1-init.js');
        console.log("[Kernel][Boot] Step 1: Secure Query Initialization Module loaded.");

        // Input Adapter — load sau Step 1 để dùng được Logger, setPipelineState
        await import('./input-adapter.js');
        console.log("[Kernel][Boot] Input Adapter: Input routing layer loaded.");
        
        // Step 2 ngay sau Step 1 để đăng ký Geo Routing Handler
        await import('./step2-geo-routing.js');
        console.log("[Kernel][Boot] Step 2: Geo Routing Layer loaded.");
        
        // Step 3 hook vào Step 2 sau khi Step 2 đã sẵn sàng
        await import('./step3-fallback-chain.js');
        console.log("[Kernel][Boot] Step 3: Global Fallback Chain loaded.");
        
        await import('./step4-rag-layer.js');
        console.log("[Kernel][Boot] Step 4: Distributed RAG Layer loaded.");
        
        await import('./step5-cache-layer.js');
        console.log("[Kernel][Boot] Step 5: Client-side Cache Layer loaded.");
        
        await import('./nktg_brain_encoder.js');
        console.log("[Kernel][Boot] Step 6a: Brain Encoder loaded.");
        
        await import('./nktg_cerebellum.js');
        console.log("[Kernel][Boot] Step 6b: Cerebellum Engine loaded.");
        
        await import('./step7-nktg-kernel.js');
        console.log("[Kernel][Boot] Step 7: NKTg Law Kernel loaded.");
        
        await import('./step8-output-layer.js');
        console.log("[Kernel][Boot] Step 8: Output Generation Layer loaded.");
        
        await import('./step9-distributed-sync.js');
        console.log("[Kernel][Boot] Step 9: Distributed Sync Layer loaded.");
        
        console.log("[Kernel] All pipeline modules compiled and chained sequentially. Core Engine Ready.");
    } catch (bootError) {
        console.error("[Kernel][Fatal] Critical pipeline compilation failure during boot sequence:", bootError);
    }
})();

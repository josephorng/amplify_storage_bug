"use client";

import styles from "./page.module.css";
import { useState } from "react";
import { StorageManager } from "@/storage/StorageManager";

export default function Home() {
  const [debugOutput, setDebugOutput] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Create a StorageManager instance for debugging
  const storageManager = new StorageManager({
    daysToLive: 7,
    s3PublicPrefix: "public",
    s3PrivatePrefix: "private",
    useLearnerId: false,
    usePublicData: true,
    usePrivateData: true,
    useS3PublicFolder: true,
    dataType: "debug",
    currentLearner: null,
    userId: "debug-user"
  });


  const handleSyncWithDebounce = async () => {
    setIsLoading(true);
    setDebugOutput("Testing syncWithDebounce function...\n");
    
    try {
      const result = await storageManager.syncWithDebounce();
      setDebugOutput(prev => prev + `Sync result: ${JSON.stringify(result, null, 2)}\n`);
      console.log("Debug - syncWithDebounce result:", result);
    } catch (error) {
      const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      setDebugOutput(prev => prev + errorMessage + "\n");
      console.error("Debug - syncWithDebounce error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearDatabase = async () => {
    setIsLoading(true);
    setDebugOutput("Clearing entire IndexedDB database...\n");
    
    try {
      const result = await storageManager.clearEntireDatabase();
      if (result.success) {
        setDebugOutput(prev => prev + "IndexedDB database cleared successfully!\n");
        console.log("Database cleared successfully");
      } else {
        setDebugOutput(prev => prev + `Error clearing database: ${result.error}\n`);
        console.error("Error clearing database:", result.error);
      }
    } catch (error) {
      const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      setDebugOutput(prev => prev + errorMessage + "\n");
      console.error("Clear database error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const clearDebugOutput = () => {
    setDebugOutput("");
  };

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div style={{ marginBottom: '2rem' }}>
          <h2>StorageManager Debug Tools</h2>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <button
              onClick={handleSyncWithDebounce}
              disabled={isLoading}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#0070f3',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                opacity: isLoading ? 0.6 : 1
              }}
            >
              {isLoading ? 'Loading...' : 'Test syncWithDebounce (1s)'}
            </button>
            
            
            <button
              onClick={handleClearDatabase}
              disabled={isLoading}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                opacity: isLoading ? 0.6 : 1
              }}
            >
              {isLoading ? 'Loading...' : 'Clear IndexedDB'}
            </button>
            
            <button
              onClick={clearDebugOutput}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Clear Output
            </button>
          </div>
          
          <div style={{
            backgroundColor: '#f8f9fa',
            border: '1px solid #dee2e6',
            borderRadius: '4px',
            padding: '1rem',
            minHeight: '200px',
            fontFamily: 'monospace',
            fontSize: '14px',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            color: '#000000'
          }}>
            {debugOutput || "Debug output will appear here..."}
          </div>
        </div>
      </main>
    </div>
  );
}

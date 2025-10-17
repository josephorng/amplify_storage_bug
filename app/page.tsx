"use client";

import Image from "next/image";
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

  const handleGetLastUsedDevice = async () => {
    setIsLoading(true);
    setDebugOutput("Getting last used device from S3...\n");
    
    try {
      // Access the private method through type assertion for debugging
      const result = await (storageManager as any).getLastUsedDeviceFromS3();
      setDebugOutput(prev => prev + `Result: ${JSON.stringify(result, null, 2)}\n`);
      console.log("Debug - getLastUsedDeviceFromS3 result:", result);
    } catch (error) {
      const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      setDebugOutput(prev => prev + errorMessage + "\n");
      console.error("Debug - getLastUsedDeviceFromS3 error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveLastUsedDevice = async () => {
    setIsLoading(true);
    const testDeviceKey = `debug-device-${Date.now()}`;
    setDebugOutput(`Saving last used device to S3: ${testDeviceKey}\n`);
    
    try {
      // Access the private method through type assertion for debugging
      await (storageManager as any).saveLastUsedDeviceToS3(testDeviceKey);
      setDebugOutput(prev => prev + `Successfully saved device key: ${testDeviceKey}\n`);
      console.log("Debug - saveLastUsedDeviceToS3 completed for:", testDeviceKey);
    } catch (error) {
      const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      setDebugOutput(prev => prev + errorMessage + "\n");
      console.error("Debug - saveLastUsedDeviceToS3 error:", error);
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
        <Image
          className={styles.logo}
          src="/next.svg"
          alt="Next.js logo"
          width={180}
          height={38}
          priority
        />
        
        <div style={{ marginBottom: '2rem' }}>
          <h2>StorageManager Debug Tools</h2>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <button
              onClick={handleGetLastUsedDevice}
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
              {isLoading ? 'Loading...' : 'Get Last Used Device from S3'}
            </button>
            
            <button
              onClick={handleSaveLastUsedDevice}
              disabled={isLoading}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                opacity: isLoading ? 0.6 : 1
              }}
            >
              {isLoading ? 'Loading...' : 'Save Last Used Device to S3'}
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
            overflow: 'auto'
          }}>
            {debugOutput || "Debug output will appear here..."}
          </div>
        </div>

        <ol>
          <li>
            Get started by editing <code>app/page.tsx</code>.
          </li>
          <li>Save and see your changes instantly.</li>
        </ol>

        <div className={styles.ctas}>
          <a
            className={styles.primary}
            href="https://vercel.com/new?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Image
              className={styles.logo}
              src="/vercel.svg"
              alt="Vercel logomark"
              width={20}
              height={20}
            />
            Deploy now
          </a>
          <a
            href="https://nextjs.org/docs?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.secondary}
          >
            Read our docs
          </a>
        </div>
      </main>
      <footer className={styles.footer}>
        <a
          href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            aria-hidden
            src="/file.svg"
            alt="File icon"
            width={16}
            height={16}
          />
          Learn
        </a>
        <a
          href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            aria-hidden
            src="/window.svg"
            alt="Window icon"
            width={16}
            height={16}
          />
          Examples
        </a>
        <a
          href="https://nextjs.org?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            aria-hidden
            src="/globe.svg"
            alt="Globe icon"
            width={16}
            height={16}
          />
          Go to nextjs.org →
        </a>
      </footer>
    </div>
  );
}

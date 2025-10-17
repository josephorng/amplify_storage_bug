// StorageManager.ts
// This class is used to manage the storage of data in IndexedDB and S3 (cache).
// It does not handle appsync data.
//
// IMPORTANT: This class now uses dynamic store names based on the storeName parameter.
// The old hardcoded store names (publicDataStore, privateDataStore, inputDataStore)
// are no longer used. When upgrading from version 1 or 2, old stores will be removed.
// Users can call migrateFromOldStoreNames() to preserve existing data before upgrading.

import { Schema } from "@/amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { downloadData, uploadData, remove } from "aws-amplify/storage";
import { createHash } from "crypto";
import {
  IndexedDBPrivateData,
  IndexedDBPublicData,
  IndexedDBMetadata,
  LearnerPrivateData,
  DeviceKeyMetadata,
  LearnerSidebarItemData,
} from "@/storage/types";
import PATHS from "@/storage/path";
import { getCurrentUser } from "aws-amplify/auth";

interface StorageManagerProps {
  daysToLive: number;
  s3PublicPrefix: string;
  s3PrivatePrefix: string;
  useLearnerId: boolean;
  usePublicData: boolean;
  usePrivateData: boolean;
  useS3PublicFolder: boolean;
  dataType: string;
  currentLearner: LearnerSidebarItemData | null;
  userId: string | null;
}

export class StorageManager<inputType, PublicData, PrivateData> {
  protected client: ReturnType<typeof generateClient<Schema>>;
  private timeToLive: number; // in milliseconds
  private db: IDBDatabase | null = null;
  private readonly dbName: string = "StorageManagerDB";
  private readonly publicStoreName: string = "publicDataStore";
  private readonly privateStoreName: string = "privateDataStore";
  private readonly metadataStoreName: string = "metadataStore";
  private readonly index_dataType: string = "dataType";
  private readonly index_userId: string = "userId";
  private readonly index_lastRead: string = "lastRead";
  private dataType: string = "";
  private userId: string | null = null; // Can be set by subclasses
  private currentLearner: LearnerSidebarItemData | null = null;
  private useLearnerId: boolean = true;
  private usePublicData: boolean = true;
  private usePrivateData: boolean = true;
  private useS3PublicFolder: boolean = true;
  /**
   * S3 prefix for organizing files in S3. Subclasses can override this.
   * Default is empty string (no prefix).
   */
  protected s3PublicPrefix: string = "";
  protected s3PrivatePrefix: string = "";
  /**
   * Key for storing the write counter in IndexedDB
   */
  private readonly lastUpdatedKey: string = "privateDataLastUpdated";

  /**
   * Map to track debounce timers per storeName to prevent excessive sync calls
   */
  private static debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor({
    daysToLive,
    s3PublicPrefix,
    s3PrivatePrefix,
    useS3PublicFolder,
    useLearnerId,
    usePublicData,
    usePrivateData,
    dataType,
    currentLearner: currentLearner,
    userId,
  }: StorageManagerProps) {
    this.client = generateClient<Schema>({ authMode: "userPool" });
    if (useLearnerId && !currentLearner) {
      throw new Error("Learner ID is required");
    }
    if (usePrivateData && !userId) {
      throw new Error("User ID is required");
    }
    if (!usePublicData && !usePrivateData) {
      throw new Error("usePublicData and usePrivateData cannot both be false");
    }
    if (useS3PublicFolder && !usePublicData) {
      throw new Error(
        "useS3PublicFolder cannot be true if usePublicData is false"
      );
    }
    if (s3PrivatePrefix.endsWith("/")) {
      s3PrivatePrefix = s3PrivatePrefix.slice(0, -1);
    }
    if (s3PublicPrefix.endsWith("/")) {
      s3PublicPrefix = s3PublicPrefix.slice(0, -1);
    }
    this.timeToLive = daysToLive * 24 * 60 * 60 * 1000;
    this.usePublicData = usePublicData;
    this.useS3PublicFolder = useS3PublicFolder;
    this.usePrivateData = usePrivateData;
    this.useLearnerId = useLearnerId;
    this.s3PublicPrefix = s3PublicPrefix;
    this.s3PrivatePrefix = s3PrivatePrefix;
    this.dataType = dataType;
    this.lastUpdatedKey = dataType + "PrivateDataLastUpdated";
    this.currentLearner = currentLearner;
    this.userId = userId;
    this.initIndexedDB().catch((error) => {
      console.error("Failed to initialize IndexedDB:", error);
    });
  }

  public async initUserId(): Promise<string | null> {
    const user = await getCurrentUser();
    this.userId = user.signInDetails?.loginId || null;
    return this.userId;
  }

  public getUsePublicData(): boolean {
    return this.usePublicData;
  }

  public getUsePrivateData(): boolean {
    return this.usePrivateData;
  }

  private getS3PrivatePathFunction(): ({
    identityId,
  }: {
    identityId?: string | undefined;
  }) => string {
    return ({ identityId }) =>
      `private/snapshot/${identityId}/${this.s3PrivatePrefix}.json`;
  }

  private getS3DevicePathFunction(): string {
    return `public/metadata/deviceKey/${this.dataType}.json`;
  }

  /**
   * Get the last updated time for private data from IndexedDB
   */
  private async getPrivateDataLastUpdatedTime(): Promise<number> {
    try {
      if (!this.db) {
        await this.initIndexedDB();
        if (!this.db) {
          return 0;
        }
      }

      const transaction = this.db.transaction(
        [this.metadataStoreName],
        "readonly"
      );
      const store = transaction.objectStore(this.metadataStoreName);
      const request = store.get(this.lastUpdatedKey);

      return new Promise((resolve) => {
        request.onsuccess = () => {
          if (request.result && request.result.data !== undefined) {
            resolve(request.result.data);
          } else {
            resolve(0);
          }
        };
        request.onerror = () => {
          console.warn(
            "Failed to read last updated time from IndexedDB:",
            request.error
          );
          resolve(0);
        };
      });
    } catch (error) {
      console.warn("Failed to get last updated time from IndexedDB:", error);
      return 0;
    }
  }

  /**
   * Save the last updated time to IndexedDB
   */
  private async savePrivateDataLastUpdatedTime(
    timestamp: number
  ): Promise<void> {
    try {
      if (!this.userId) {
        return;
      }
      if (!this.db) {
        await this.initIndexedDB();
        if (!this.db) {
          return;
        }
      }

      const lastUpdatedData: IndexedDBMetadata<number> = {
        key: this.lastUpdatedKey,
        userId: this.userId,
        lastRead: Date.now(),
        data: timestamp,
        createdAt: Date.now(),
        dataType: this.dataType,
      };

      const transaction = this.db.transaction(
        [this.metadataStoreName],
        "readwrite"
      );
      const store = transaction.objectStore(this.metadataStoreName);
      store.put(lastUpdatedData);
      console.log(
        "Saved last updated time to IndexedDB:",
        lastUpdatedData,
        this.dataType
      );
    } catch (error) {
      console.warn("Failed to save last updated time to IndexedDB:", error);
    }
  }

  /**
   * Get user ID
   */
  public getUserId(): string | null {
    return this.userId;
  }

  /**
   * Initialize IndexedDB with separate stores for public, private, and input data
   */
  private async initIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 7); // Increment version for new storeName indexes

      let upgradeCompleted = false;
      let upgradeStarted = false;

      request.onerror = () => {
        console.error(`[DEBUG] IndexedDB open request failed:`, request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;

        // Only resolve if no upgrade is needed or upgrade has completed
        if (!upgradeStarted || upgradeCompleted) {
          resolve();
        } else {
        }
      };

      request.onupgradeneeded = (event) => {
        upgradeStarted = true;

        const db = (event.target as IDBOpenDBRequest).result;

        try {
          // Delete all existing object stores first
          const existingStoreNames = Array.from(db.objectStoreNames);
          for (const storeName of existingStoreNames) {
            console.log(`Deleting existing object store: ${storeName}`);
            db.deleteObjectStore(storeName);
          }

          // Note: Indexes are created when stores are created below
          // We cannot modify existing stores during version upgrades

          // Create new stores if they don't exist (for fresh installations or after migration)
          const publicStore = db.createObjectStore(this.publicStoreName, {
            keyPath: "key",
          });
          publicStore.createIndex(this.index_lastRead, this.index_lastRead, {
            unique: false,
          });
          publicStore.createIndex(this.index_dataType, this.index_dataType, {
            unique: false,
          });

          const privateStore = db.createObjectStore(this.privateStoreName, {
            keyPath: "key",
          });
          privateStore.createIndex(this.index_lastRead, this.index_lastRead, {
            unique: false,
          });
          privateStore.createIndex(this.index_userId, this.index_userId, {
            unique: false,
          });
          privateStore.createIndex(this.index_dataType, this.index_dataType, {
            unique: false,
          });

          const metadataStore = db.createObjectStore(this.metadataStoreName, {
            keyPath: "key",
          });
          metadataStore.createIndex(this.index_lastRead, this.index_lastRead, {
            unique: false,
          });
          metadataStore.createIndex(this.index_userId, this.index_userId, {
            unique: false,
          });
          metadataStore.createIndex(this.index_dataType, this.index_dataType, {
            unique: false,
          });

          // Mark upgrade as completed
          upgradeCompleted = true;

          // Resolve the promise after upgrade is complete
          resolve();
        } catch (error) {
          console.error("Error during IndexedDB upgrade:", error);
          throw error;
        }
      };
    });
  }

  public isLearnerValid(): boolean {
    if (!this.useLearnerId) {
      return true;
    }
    return this.currentLearner !== null;
  }

  protected getCurrentLearner(): LearnerSidebarItemData {
    if (!this.currentLearner) {
      throw new Error("Current learner not found");
    }
    return this.currentLearner || null;
  }

  // ==================== PUBLIC DATA OPERATIONS ====================

  /**
   * Create public data (stored in both IndexedDB and S3)
   */
  public async createPublicData(
    input: inputType,
    createFunction: () => Promise<{
      publicData: PublicData | null;
      error: string | null;
    }>,
    checkDataValid: boolean = true
  ): Promise<{ publicData: PublicData | null; error: string | null }> {
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return { publicData: null, error: "Public data operations are disabled" };
    }

    const key = this.getPublicKey(input);
    const { publicData: data, error } = await createFunction();

    if (!data || error) {
      return { publicData: null, error: error || "Data is null" };
    }

    if (!this.isDataValid(data) && checkDataValid && this.useS3PublicFolder) {
      console.log("Data is not valid and useS3PublicFolder is true");
      return {
        publicData: null,
        error: "Data is not valid and useS3PublicFolder is true",
      };
    }

    const indexedDBData: IndexedDBPublicData<PublicData> = {
      key: key,
      lastS3Modified: Date.now(),
      lastS3Sync: Date.now(),
      lastRead: Date.now(),
      createdAt: Date.now(),
      data: data,
      storeName: this.dataType,
    };

    // Store to IndexedDB and S3 in parallel
    await Promise.all([
      this.setPublicIndexedDBData(indexedDBData),
      this.setS3PublicData(key, indexedDBData),
    ]);

    return { publicData: data, error: null };
  }

  /**
   * Read public data (from IndexedDB first, then S3 if needed).
   * There is no readPublicData, because we need input to get the key.
   */
  public async readPublicData(
    input: inputType,
    createFunction: () => Promise<{
      publicData: PublicData | null;
      error: string | null;
    }>,
    checkDataValid: boolean = true
  ): Promise<{ publicData: PublicData | null; error: string | null }> {
    if (!this.useS3PublicFolder) {
      return {
        publicData: null,
        error: "Do not use readPublicData if useS3PublicFolder is false",
      };
    }
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return { publicData: null, error: "Public data operations are disabled" };
    }

    const key = this.getPublicKey(input);

    // Try to get from IndexedDB first
    let indexedDBData = await this.readPublicIndexedDBData(key);

    const data = indexedDBData?.data as PublicData;

    if (indexedDBData && data !== null && (checkDataValid ? this.isDataValid(data) : true)) {
      // Update lastRead timestamp
      indexedDBData.lastRead = Date.now();
      await this.setPublicIndexedDBData(indexedDBData);
      return { publicData: data, error: null };
    }

    // If not found in IndexedDB, try S3
    const s3Data = this.useS3PublicFolder ? await this.getS3Data(key) : null;
    if (s3Data && (checkDataValid ? this.isDataValid(s3Data as PublicData) : true)) {
      // Store to IndexedDB
      await this.setPublicIndexedDBData({
        key: key,
        lastS3Modified: Date.now(),
        lastS3Sync: Date.now(),
        lastRead: Date.now(),
        createdAt: Date.now(),
        data: s3Data,
        storeName: this.dataType,
      });
      return { publicData: s3Data as PublicData, error: null };
    }

    // If not found anywhere, create new data
    return await this.createPublicData(input, createFunction, checkDataValid);
  }

  /**
   * Read public data without creating if not exists
   */
  public async readPublicDataWithoutCreate(
    input: inputType
  ): Promise<{ publicData: PublicData | null; error: string | null }> {
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return { publicData: null, error: "Public data operations are disabled" };
    }

    return this.readPublicData(input, async () => ({
      publicData: null,
      error: null,
    }));
  }

  /**
   * Read public data by ID (when input is not available)
   */
  public async readPublicDataWithoutCreateByKey(
    key: string
  ): Promise<PublicData | null> {
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return null;
    }

    // Try to get from IndexedDB first
    const publicKey = this.getPublicKey(key);
    let indexedDBData = await this.readPublicIndexedDBData(publicKey);

    if (indexedDBData && indexedDBData.data) {
      // Update lastRead timestamp
      indexedDBData.lastRead = Date.now();
      await this.setPublicIndexedDBData(indexedDBData);
      return indexedDBData.data;
    }

    // If not found in IndexedDB, try S3
    const s3Data = this.useS3PublicFolder ? await this.getS3Data(key) : null;
    if (s3Data) {
      // Store to IndexedDB
      await this.setPublicIndexedDBData({
        key: key,
        lastS3Modified: Date.now(),
        lastS3Sync: Date.now(),
        lastRead: Date.now(),
        createdAt: Date.now(), // Set current time for S3 data that doesn't have createdAt
        data: s3Data,
        storeName: this.dataType,
      });
      return s3Data as PublicData;
    }

    // If not found anywhere, return null
    return null;
  }

  /**
   * Update public data
   */
  public async updatePublicData(
    input: inputType,
    newData: Partial<PublicData>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return { success: true };
    }

    const key = this.getPublicKey(input);

    // Get existing data to preserve createdAt
    const existingData = await this.readPublicIndexedDBData(key);

    if (!existingData) {
      return { success: false, error: `Public data not found for key: ${key}` };
    }

    const indexedDBData: IndexedDBPublicData<PublicData> = {
      key: key,
      lastS3Modified: Date.now(),
      lastS3Sync: Date.now(),
      lastRead: Date.now(),
      createdAt: existingData?.createdAt || Date.now(), // Preserve existing createdAt or use current time if none exists
      data: {
        ...existingData?.data,
        ...newData,
      },
      storeName: this.dataType,
    };

    // Update IndexedDB
    const [publicIndexedDBResult, s3Result] = await Promise.all([
      this.setPublicIndexedDBData(indexedDBData),
      this.setS3PublicData(key, indexedDBData),
    ]);
    if (!publicIndexedDBResult || !s3Result) {
      return {
        success: false,
        error:
          "Failed to update public data" +
          publicIndexedDBResult?.error +
          " " +
          s3Result?.error,
      };
    }
    return { success: true };
  }

  /**
   * Update public data by ID (when input is not available)
   */
  public async updatePublicDataByKey(
    key: string,
    newData: Partial<PublicData>
  ): Promise<void> {
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return;
    }

    const publicKey = this.getPublicKey(key);
    const originalData = await this.readPublicIndexedDBData(publicKey);
    if (!originalData || !originalData.data) {
      throw new Error(`Public data not found for ID: ${key}`);
    }

    const indexedDBData: IndexedDBPublicData<PublicData> = {
      key: key,
      lastS3Modified: Date.now(),
      lastS3Sync: Date.now(),
      lastRead: Date.now(),
      createdAt: originalData.createdAt, // Preserve existing createdAt
      data: {
        ...originalData.data,
        ...newData,
      },
      storeName: this.dataType,
    };

    // Update IndexedDB
    await this.setPublicIndexedDBData(indexedDBData);

    await this.setS3PublicData(key, indexedDBData);
  }

  // ==================== PRIVATE DATA OPERATIONS ====================

  /**
   * Create private data only (stored only in IndexedDB, user-specific)
   */
  public async createPrivateData(
    input: inputType,
    privateData: PrivateData
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.usePrivateData) {
      return { success: true }; // No error, just disabled
    }

    const key = await this.getPrivateKey(input);
    const { success, error } = await this.createPrivateDataByKey(
      key,
      privateData
    );
    if (!success) {
      console.error("Error creating private data:", error);
      return { success: false, error };
    }
    return { success: true };
  }

  /**
   * Create private data only (stored only in IndexedDB, user-specific)
   */
  public async createPrivateDataByKey(
    key: string,
    privateData: PrivateData
  ): Promise<{ success: boolean; data: PrivateData | null; error?: string }> {
    if (!this.usePrivateData) {
      return {
        success: true,
        data: null,
        error: "Private data operations are disabled",
      }; // No error, just disabled
    }
    if (!this.userId || !this.isLearnerValid()) {
      return {
        success: false,
        data: null,
        error:
          "User ID or learner ID not found, userId: " +
          this.userId +
          " learnerId: " +
          this.currentLearner,
      };
    }

    const privateKey = await this.getPrivateKey(key);
    const newIndexedDBData: IndexedDBPrivateData<PrivateData> = {
      key: privateKey,
      userId: this.userId,
      learnerId: this.currentLearner?.id || "",
      lastRead: Date.now(),
      lastModified: Date.now(),
      data: privateData,
      createdAt: Date.now(),
      dataType: this.dataType,
      deleted: false,
    };
    console.log("debug: createPrivateDataByKey: privateData", privateData);
    console.log(
      "debug: createPrivateDataByKey: newIndexedDBData.data",
      newIndexedDBData.data
    );
    await this.setPrivateIndexedDBData(newIndexedDBData);

    return { success: true, data: privateData };
  }

  /**
   * Read private data
   */
  public async readPrivateData(
    input: inputType
  ): Promise<{ data: PrivateData | null; error?: string }> {
    if (!this.usePrivateData) {
      return { data: null, error: "Private data operations are disabled" };
    }

    const key = await this.getPrivateKey(input);
    return await this.readPrivateDataByKey(key);
  }

  /**
   * Read private data by key
   */
  public async readPrivateDataByKey(
    key: string
  ): Promise<{ data: PrivateData | null; error?: string }> {
    if (!this.usePrivateData) {
      return { data: null, error: "Private data operations are disabled" };
    }
    const privateKey = await this.getPrivateKey(key);
    const indexedDBData = await this.readPrivateIndexedDBData(privateKey);

    if (indexedDBData && indexedDBData.data !== undefined) {
      // Update lastRead timestamp
      indexedDBData.lastRead = Date.now();
      console.log("debug: readPrivateDataByKey: indexedDBData", indexedDBData);
      await this.setPrivateIndexedDBData(indexedDBData);
      return { data: indexedDBData.data, error: undefined };
    }

    return { data: null, error: "Private data with key " + key + " not found" };
  }

  /**
   * Update private data
   * If the data does not exist, it will be created
   */
  public async updatePrivateData(
    input: inputType,
    newPrivateData: Partial<PrivateData>
  ): Promise<{ data: PrivateData | null; error?: string }> {
    if (!this.usePrivateData) {
      return { data: null, error: "Private data operations are disabled" }; // No error, just disabled
    }

    const privateKey = await this.getPrivateKey(input);
    const { data, error } = await this.updatePrivateDataByKey(
      privateKey,
      newPrivateData
    );
    if (error) {
      console.error("Error updating private data:", error);
      return { data: null, error };
    }
    return { data, error };
  }

  /**
   * Update private data by key
   * If the data does not exist, it will be created
   */
  public async updatePrivateDataByKey(
    key: string,
    newPrivateData: Partial<PrivateData>
  ): Promise<{ data: PrivateData | null; error?: string }> {
    if (!this.usePrivateData) {
      return { data: null, error: "Private data operations are disabled" }; // No error, just disabled
    }
    if (!this.userId || !this.isLearnerValid()) {
      return {
        data: null,
        error: "User ID or learner ID not found",
      };
    }

    const privateKey = await this.getPrivateKey(key);
    const existingData = await this.readPrivateIndexedDBData(privateKey);

    if (!existingData) {
      return {
        data: null,
        error: "Private data with key " + key + " not found",
      };
    } else {
      const updatedData: IndexedDBPrivateData<PrivateData> = {
        key: existingData.key,
        userId: existingData.userId,
        learnerId: existingData.learnerId,
        lastRead: Date.now(),
        lastModified: Date.now(),
        createdAt: existingData.createdAt,
        data: {
          ...existingData.data,
          ...newPrivateData,
        },
        dataType: existingData.dataType,
        deleted: existingData.deleted,
      };

      // Update IndexedDB
      console.log("debug: updatePrivateDataByKey: updatedData", updatedData);
      await this.setPrivateIndexedDBData(updatedData);

      return { data: updatedData.data };
    }
  }

  /**
   * Clear the entire IndexedDB database
   * WARNING: This will delete ALL data for ALL users
   */
  public async clearEntireDatabase(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      if (!this.db) {
        await this.initIndexedDB();
        if (!this.db) {
          console.error("IndexedDB not initialized");
          throw new Error("IndexedDB not initialized");
        }
      }

      console.log("Clearing entire IndexedDB database");

      // Clear public data store
      await this.clearObjectStore(this.publicStoreName);

      // Clear private data store
      await this.clearObjectStore(this.privateStoreName);

      console.log("Entire IndexedDB database cleared successfully");

      return { success: true };
    } catch (error) {
      console.error("Error clearing entire database:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Clear a specific object store
   */
  private async clearObjectStore(storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);

      // Instead of clearing all data, only clear data for current storeName
      if (storeName === this.publicStoreName) {
        // For public store, filter by storeName
        const index = store.index(this.index_dataType);
        const request = index.openCursor(IDBKeyRange.only(this.dataType));

        request.onerror = () => reject(request.error);
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor) {
            console.log("clearObjectStore delete", cursor.primaryKey);
            store.delete(cursor.primaryKey);
            cursor.continue();
          } else {
            resolve();
          }
        };
      } else {
        // For private and input stores, filter by both userId and storeName
        const index = store.index(this.index_userId);
        const request = index.openCursor(IDBKeyRange.only(this.userId));

        request.onerror = () => reject(request.error);
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor) {
            const record = cursor.value;
            if (record.dataType === this.dataType) {
              console.log("clearObjectStore delete", cursor.primaryKey);
              store.delete(cursor.primaryKey);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
      }
    });
  }

  /**
   * Check if private data exists
   */
  public async hasPrivateData(input: inputType): Promise<boolean> {
    if (!this.usePrivateData) {
      return false;
    }

    const privateKey = await this.getPrivateKey(input);
    return await this.hasPrivateDataByKey(privateKey);
  }

  /**
   * Check if private data exists by key
   */
  public async hasPrivateDataByKey(key: string): Promise<boolean> {
    if (!this.usePrivateData) {
      return false;
    }

    const privateKey = await this.getPrivateKey(key);
    const indexedDBData = await this.readPrivateIndexedDBData(privateKey);
    return indexedDBData?.data !== undefined;
  }

  /**
   * Get all private data for current user
   */
  public async getAllPrivateData(): Promise<{
    data: PrivateData[];
    error?: string;
  }> {
    if (!this.usePrivateData) {
      return { data: [], error: "Private data operations are disabled" };
    }

    const allData = await this.getAllPrivateIndexedDBData();
    return {
      data: allData
        .map((item) => item.data)
        .filter(
          (privateData): privateData is PrivateData => privateData !== undefined
        ),
      error: undefined,
    };
  }

  /**
   * Get private data keys for current user
   */
  public async getPrivateDataKeys(): Promise<string[]> {
    if (!this.usePrivateData) {
      return [];
    }

    const allData = await this.getAllPrivateIndexedDBData();
    const privateKeysPromises = allData.map((item) =>
      this.getPrivateKey(item.key)
    );
    const privateKeys = await Promise.all(privateKeysPromises);
    return privateKeys;
  }

  // ==================== UTILITY OPERATIONS ====================

  /**
   * Check if data exists by ID
   */
  public async exists(input: inputType): Promise<boolean> {
    if (!this.usePublicData && !this.usePrivateData) {
      console.log("Public and private data operations are disabled");
      return false;
    }

    const publicKey = this.getPublicKey(input);
    const privateKey = await this.getPrivateKey(input);

    let publicExists = false;
    let privateExists = false;

    if (this.usePublicData) {
      publicExists = await this.publicExistsById(publicKey);
    }

    if (this.usePrivateData) {
      privateExists = await this.privateExistsById(privateKey);
    }

    const exists = publicExists || privateExists;
    return exists;
  }

  /**
   * Check if data is valid according to a validation function
   */
  public isDataValid(data: PublicData): boolean {
    if (data === null || data === undefined) {
      return false;
    }

    // Check that all attributes in data object are not empty/null/undefined
    for (const key in data) {
      const value = data[key];
      console.log("debug: isDataValid: key", key, "value", value);
      if (value === null || value === undefined || value === "") {
        return false;
      }

      // Check array values
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return false;
        }
        for (const item of value) {
          if (!item) {
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Check if public data exists by ID
   */
  public async publicExistsById(key: string): Promise<boolean> {
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return false;
    }

    // Check IndexedDB first
    const indexedDBData = await this.readPublicIndexedDBData(key);
    if (indexedDBData) {
      return true;
    }

    try {
      const s3Data = await this.getS3Data(key);
      return s3Data !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if private data exists by ID
   */
  public async privateExistsById(key: string): Promise<boolean> {
    if (!this.usePrivateData) {
      return false;
    }

    const indexedDBData = await this.readPrivateIndexedDBData(key);
    return indexedDBData !== null;
  }

  /**
   * Delete data by ID (when input is not available)
   */
  public async deleteDataById(
    key: string
  ): Promise<{ success: boolean; error?: string }> {
    // Delete from both public and private stores if enabled
    if (this.usePublicData) {
      const publicKey = this.getPublicKey(key);
      const { success: publicSuccess, error: publicError } =
        await this.deletePublicIndexedDBDataByKey(publicKey);
      if (!publicSuccess) {
        return { success: false, error: publicError };
      }
    }

    if (this.usePrivateData) {
      const privateKey = await this.getPrivateKey(key);
      const { success: privateSuccess, error: privateError } =
        await this.deletePrivateIndexedDBDataByKey(privateKey);
      if (!privateSuccess) {
        return { success: false, error: privateError };
      }
    }

    return { success: true };
  }

  // ==================== PRIVATE METHODS ====================

  /**
   * Get public key using SHA256 hash
   */
  public getPublicKey(input: inputType | string): string {
    if (!this.s3PublicPrefix) {
      throw new Error(
        "s3Prefix is not set. Please set the s3Prefix in the subclass."
      );
    }
    const inputStringHash = this.getInputId(input);
    return `${this.s3PublicPrefix}/${inputStringHash}`;
  }

  /**
   * Get private key using SHA256 hash with user ID
   */
  public async getPrivateKey(input: inputType | string): Promise<string> {
    if (!this.userId || this.userId === "") {
      throw new Error("User ID is not set. Please set the user ID.");
    }
    const inputStringHash = this.getInputId(input);
    const userIdHash = createHash("sha256").update(this.userId).digest("hex");
    return `${this.s3PrivatePrefix}/${userIdHash}/${inputStringHash}`;
  }

  /**
   * Get input key hash
   * You can put
   */
  public getInputId(input: inputType | string): string {
    if (typeof input === "string") {
      return input.split("/").pop() || "";
    }
    const inputStringHash = this.getHash(input);
    return inputStringHash;
  }

  protected getHash(input: inputType): string {
    const inputStringHash = StorageManager.stableStringify(input);
    const inputStringHashHash = createHash("sha256")
      .update(inputStringHash)
      .digest("hex");
    return inputStringHashHash;
  }

  /**
   * Private function: Stable stringify
   */
  static stableStringify(obj: any): string {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return (
        "{" +
        Object.keys(obj)
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) + ":" + StorageManager.stableStringify(obj[k])
          )
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(obj);
  }

  /**
   * Private function: Read public IndexedDB data
   */
  protected async readPublicIndexedDBData(
    key: string
  ): Promise<IndexedDBPublicData<PublicData> | null> {
    if (!this.usePublicData) {
      return null;
    }
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.publicStoreName],
        "readonly"
      );
      const store = transaction.objectStore(this.publicStoreName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  /**
   * Private function: Check if public IndexedDB data exists
   */
  protected async hasPublicIndexedDBData(key: string): Promise<boolean> {
    const indexedDBData = await this.readPublicIndexedDBData(key);
    return indexedDBData !== null;
  }

  /**
   * Private function: Read private IndexedDB data
   */
  protected async readPrivateIndexedDBData(
    key: string
  ): Promise<IndexedDBPrivateData<PrivateData> | null> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }
    // console.log(`Getting private IndexedDB data for key ${key}`);
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.privateStoreName],
        "readonly"
      );
      const store = transaction.objectStore(this.privateStoreName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  /**
   * Private function: Check if private IndexedDB data exists
   */
  protected async hasPrivateIndexedDBData(key: string): Promise<boolean> {
    const indexedDBData = await this.readPrivateIndexedDBData(key);
    return indexedDBData !== null;
  }

  /**
   * Private function: Set public IndexedDB data
   */
  private async setPublicIndexedDBData(
    data: IndexedDBPublicData<PublicData>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        return { success: false, error: "IndexedDB not initialized" };
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.publicStoreName],
        "readwrite"
      );
      const store = transaction.objectStore(this.publicStoreName);
      const request = store.put({ ...data, storeName: this.dataType });

      request.onerror = () => {
        console.error(
          `Failed to set public IndexedDB data for key ${data.key}:`,
          request.error
        );
        reject(request.error);
      };
      request.onsuccess = () => {
        resolve({ success: true });
      };
    });
  }

  /**
   * Private function: Set private IndexedDB data
   */
  private async setPrivateIndexedDBData(
    data: IndexedDBPrivateData<PrivateData>,
    sync: boolean = true
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        return { success: false, error: "IndexedDB not initialized" };
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.privateStoreName],
        "readwrite"
      );
      const store = transaction.objectStore(this.privateStoreName);
      const request = store.put({
        ...data,
      });

      request.onerror = () => {
        console.error(
          `Failed to set private IndexedDB data for key ${data.key}:`,
          request.error
        );
        reject(request.error);
      };
      request.onsuccess = () => {
        if (sync) {
          this.savePrivateDataLastUpdatedTime(Date.now());
          this.syncWithDebounce();
        }
        console.log("debug: setPrivateIndexedDBData: data", data);
        resolve({ success: true });
      };
    });
  }

  /**
   * Private function: Get S3 data
   */
  protected async getS3Data(key: string): Promise<PublicData | null> {
    try {
      const downloadResult = await downloadData({
        path: key,
      }).result;

      if (downloadResult.body) {
        const text = await downloadResult.body.text();
        return JSON.parse(text);
      }
      return null;
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") {
        return null;
      }
      console.warn(`Failed to get S3 data for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Private function: Set S3 data
   */
  protected async setS3PublicData(
    key: string,
    data: IndexedDBPublicData<PublicData>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.useS3PublicFolder) {
        return { success: true };
      }
      if (!this.isDataValid(data.data)) {
        console.error(`Cannot set empty S3 data for key ${key}`);
        return { success: false, error: "Data is empty" };
      }
      await uploadData({
        path: key,
        data: JSON.stringify(data.data),
        options: {
          contentType: "application/json",
        },
      }).result;
      console.log(`Successfully set S3 data for key ${key}`);
      return { success: true };
    } catch (error) {
      console.error(`Failed to set S3 data for key ${key}:`, error);
      return { success: false, error: error as string };
    }
  }

  /**
   * Private function: Delete S3 data
   */
  private async deleteS3Data(
    key: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await remove({
        path: key,
      });
      return { success: true };
    } catch (error) {
      console.error(`Failed to delete S3 data for key ${key}:`, error);
      return { success: false, error: error as string };
    }
  }

  /**
   * Private function: Clean up expired data
   */
  public async cleanUp(): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }

    const cutoffTime = Date.now() - this.timeToLive;

    // Clean up public data only if enabled
    if (this.usePublicData) {
      await this.cleanUpStore(this.publicStoreName, cutoffTime);
    }

    // Clean up private data for current user only if enabled
    if (this.usePrivateData) {
      await this.cleanUpPrivateStore(this.privateStoreName, cutoffTime);
    }
  }

  /**
   * Clean up specific store
   */
  private async cleanUpStore(
    storeName: string,
    cutoffTime: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);
      const index = store.index("lastRead");
      const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const record = cursor.value;
          // Only delete if it belongs to current storeName
          if (record.dataType === this.dataType) {
            console.log("cleanUpStore delete", cursor.primaryKey);
            store.delete(cursor.primaryKey);
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  /**
   * Clean up private store for current user only
   */
  private async cleanUpPrivateStore(
    storeName: string,
    cutoffTime: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);
      const index = store.index("lastRead");
      const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const record = cursor.value;
          // Only delete if it belongs to current user and storeName
          if (
            record.userId === this.userId &&
            record.dataType === this.dataType
          ) {
            console.log("cleanUpPrivateStore delete", cursor.primaryKey);
            store.delete(cursor.primaryKey);
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  /**
   * Get storage statistics
   */
  public async getStats(): Promise<{
    totalPublicItems: number;
    totalPrivateItems: number;
    expiredPublicItems: number;
    expiredPrivateItems: number;
    timeToLive: number;
    userId: string | null;
  }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }

    let totalPublicItems = 0;
    let totalPrivateItems = 0;
    let expiredPublicItems = 0;
    let expiredPrivateItems = 0;

    // Only count public items if public data is enabled
    if (this.usePublicData) {
      totalPublicItems = await this.getIndexedDBCount(this.publicStoreName);
      const cutoffTime = Date.now() - this.timeToLive;
      expiredPublicItems = await this.getExpiredItemsCount(
        this.publicStoreName,
        cutoffTime
      );
    }

    // Only count private items if private data is enabled
    if (this.usePrivateData) {
      totalPrivateItems = await this.getIndexedDBCount(this.privateStoreName);
      const cutoffTime = Date.now() - this.timeToLive;
      expiredPrivateItems = await this.getExpiredItemsCount(
        this.privateStoreName,
        cutoffTime
      );
    }

    return {
      totalPublicItems,
      totalPrivateItems,
      expiredPublicItems,
      expiredPrivateItems,
      timeToLive: this.timeToLive,
      userId: this.userId,
    };
  }

  /**
   * Protected method to get all public data from IndexedDB for child classes
   */
  public async getAllPublicIndexedDBData(): Promise<PublicData[]> {
    if (!this.usePublicData) {
      console.log("Public data operations are disabled");
      return [];
    }

    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.publicStoreName],
        "readonly"
      );
      const store = transaction.objectStore(this.publicStoreName);
      const index = store.index(this.index_dataType);
      const request = index.getAll(this.dataType);

      request.onerror = () => reject(request.error);
      request.onsuccess = () =>
        resolve(
          request.result.filter(
            (item: any) =>
              item.key.startsWith(this.s3PublicPrefix + "/") &&
              item.dataType === this.dataType
          ) || []
        );
    });
  }

  /**
   * Helper to get all private data from IndexedDB for current user.
   * Set dataType to null to get all private data from all data types.
   */
  private async getAllPrivateIndexedDBDataGeneric<T>(
    dataType: string | null = null
  ): Promise<IndexedDBPrivateData<T>[]> {
    if (!this.usePrivateData) return [];
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) throw new Error("IndexedDB not initialized");
    }
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.privateStoreName],
        "readonly"
      );
      const store = transaction.objectStore(this.privateStoreName);
      const index = store.index(this.index_dataType);
      const request = index.getAll(dataType);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(
          (request.result || []).filter(
            (item: any) => item.userId === this.userId
          )
        );
      };
    });
  }

  /**
   * Get all private data for current user.
   */
  public async getAllPrivateIndexedDBData(): Promise<
    IndexedDBPrivateData<PrivateData>[]
  > {
    const data = await this.getAllPrivateIndexedDBDataGeneric<PrivateData>(
      this.dataType
    );
    return data;
  }

  /**
   * Get all private learner data for current user.
   */
  public async getAllPrivateLearnerIndexedDBData(): Promise<
    IndexedDBPrivateData<LearnerPrivateData>[]
  > {
    return this.getAllPrivateIndexedDBDataGeneric<LearnerPrivateData>(
      PATHS.LEARNER.DATA_TYPE
    );
  }

  /**
   * Force recreate the database if there are persistent issues
   */
  public async forceRecreateDatabase(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    // Delete the existing database
    const deleteRequest = indexedDB.deleteDatabase(this.dbName);
    await new Promise<void>((resolve, reject) => {
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onsuccess = () => resolve();
    });

    // Reinitialize
    await this.initIndexedDB();
  }

  /**
   * Private function: Delete public IndexedDB data
   */
  protected async deletePublicIndexedDBData(
    input: inputType
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.usePublicData) return { success: true };
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        return { success: false, error: "IndexedDB not initialized" };
      }
    }
    const publicKey = this.getPublicKey(input);
    const { success: deleted, error } =
      await this.deletePublicIndexedDBDataByKey(publicKey);
    return { success: deleted, error };
  }

  /**
   * Protected method to delete public data by key for child classes
   */
  protected async deletePublicIndexedDBDataByKey(
    key: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.usePublicData) {
      return { success: true };
    }

    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        return { success: false, error: "IndexedDB not initialized" };
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.publicStoreName],
        "readwrite"
      );
      const store = transaction.objectStore(this.publicStoreName);
      const publicKey = this.getPublicKey(key);
      const request = store.delete(publicKey);
      console.log("deletePublicIndexedDBDataByKey delete", request);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve({ success: true });
      };
    });
  }

  /**
   * Private function: Delete private IndexedDB data
   */
  protected async deletePrivateIndexedDBData(
    input: inputType
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        return { success: false, error: "IndexedDB not initialized" };
      }
    }
    const privateKey = await this.getPrivateKey(input);
    const { success: deleted, error } =
      await this.deletePrivateIndexedDBDataByKey(privateKey);
    return { success: deleted, error };
  }

  /**
   * Protected method to delete private data by key for child classes
   */
  public async deletePrivateIndexedDBDataByKey(
    key: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.usePrivateData) {
      return { success: true };
    }

    const privateKey = await this.getPrivateKey(key);

    return this.deletePrivateDataByKeyDirect(privateKey);
  }

  private async getIndexedDBCount(storeName: string): Promise<number> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        throw new Error("IndexedDB not initialized");
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction([storeName], "readonly");
        const store = transaction.objectStore(storeName);

        // Count only data for current storeName and userId
        if (storeName === this.publicStoreName) {
          // For public store, count by storeName
          const index = store.index(this.index_dataType);
          const request = index.count(this.dataType);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        } else {
          // For private stores, count by userId and storeName
          const index = store.index(this.index_userId);
          const request = index.getAll(this.userId);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const count = request.result.filter(
              (item: any) => item.dataType === this.dataType
            ).length;
            resolve(count);
          };
        }
      } catch (error) {
        if (error instanceof Error && error.name === "NotFoundError") {
          reject(
            new Error(
              `IndexedDB store '${storeName}' not found. This usually means the database wasn't properly initialized.`
            )
          );
        } else {
          reject(new Error(`Failed to access IndexedDB store: ${error}`));
        }
      }
    });
  }

  private async getExpiredItemsCount(
    storeName: string,
    cutoffTime: number
  ): Promise<number> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction([storeName], "readonly");
        const store = transaction.objectStore(storeName);
        const index = store.index("lastRead");
        const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));

        let count = 0;
        request.onerror = () => reject(request.error);
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor) {
            const record = cursor.value;
            // Count only expired items for current storeName and userId
            if (storeName === this.publicStoreName) {
              if (record.dataType === this.dataType) {
                count++;
              }
            } else {
              if (
                record.userId === this.userId &&
                record.dataType === this.dataType
              ) {
                count++;
              }
            }
            cursor.continue();
          } else {
            resolve(count);
          }
        };
      } catch (error) {
        if (error instanceof Error && error.name === "NotFoundError") {
          reject(
            new Error(
              `IndexedDB store '${storeName}' not found. This usually means the database wasn't properly initialized.`
            )
          );
        } else {
          reject(new Error(`Failed to access IndexedDB store: ${error}`));
        }
      }
    });
  }

  /**
   * Generic method to get all review items that combines input, public, and private data
   * This method can be used by subclasses to create their specific review item types
   * @param createSidebarItem Function to create the specific sidebar item type from combined data
   * @returns Array of review items of the specified type
   */
  protected async getAllItems<SidebarItemType>(
    createSidebarItem: (
      key: string,
      // inputData: inputType,
      publicData: PublicData | null,
      privateData: PrivateData | null,
      createdAt: number
    ) =>
      | Promise<SidebarItemType[] | SidebarItemType | null>
      | SidebarItemType[]
      | SidebarItemType
      | null
  ): Promise<SidebarItemType[]> {
    const allPrivateData = await this.getAllPrivateIndexedDBData();
    const reviewItems: SidebarItemType[] = [];

    for (const privateItem of allPrivateData) {
      if (privateItem.data) {
        const hashKey = this.getInputId(privateItem.key);
        let publicData = null;
        let privateData = null;
        let createdAt = 0;

        // Only fetch public data if public data operations are enabled
        if (this.usePublicData) {
          const publicKey = this.getPublicKey(privateItem.key);
          const publicDataResult =
            await this.readPublicIndexedDBData(publicKey);
          publicData = publicDataResult?.data || null;
        }

        // Only fetch private data if private data operations are enabled
        if (this.usePrivateData) {
          const privateKey = await this.getPrivateKey(privateItem.key);
          const privateDataResult =
            await this.readPrivateIndexedDBData(privateKey);
          if (
            privateDataResult?.deleted ||
            (this.currentLearner &&
              privateDataResult?.learnerId !== this.currentLearner?.id)
          ) {
            continue;
          }
          privateData = privateDataResult?.data || null;
          createdAt = privateDataResult?.createdAt || 0;
        }

        const sidebarItem = await createSidebarItem(
          hashKey,
          publicData,
          privateData,
          createdAt
        );

        if (sidebarItem) {
          if (Array.isArray(sidebarItem)) {
            reviewItems.push(...sidebarItem);
          } else {
            reviewItems.push(sidebarItem);
          }
        }
      }
    }
    return reviewItems;
  }

  /**
   * Force upload local data to S3 (overwrite S3 with local data)
   */
  public async forceUploadToBackend(uploadEmpty: boolean = false): Promise<{
    storeName: string;
    success: boolean;
    action: "uploaded" | "no_action_needed";
    details: string;
    error?: string;
  }> {
    if (!this.usePrivateData) {
      return {
        storeName: this.dataType,
        success: true,
        action: "no_action_needed",
        details: "Private data operations are disabled",
      };
    }

    try {
      let allPrivateData: IndexedDBPrivateData<PrivateData>[] = [];
      if (!uploadEmpty) {
        allPrivateData = await this.getAllPrivateIndexedDBData();
      }

      await this.uploadPrivateDataToS3(allPrivateData);
      return {
        storeName: this.dataType,
        success: true,
        action: "uploaded",
        details: "Local data uploaded to S3",
      };
    } catch (error) {
      console.error("Error uploading to backend:", error);
      return {
        storeName: this.dataType,
        success: false,
        action: "no_action_needed",
        details: "Error uploading to backend",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Force download data from S3 (overwrite local with S3 data)
   */
  public async forceDownloadFromBackend(): Promise<{
    storeName: string;
    success: boolean;
    action: "downloaded" | "uploaded" | "no_action_needed";
    details: string;
    error?: string;
  }> {
    if (!this.usePrivateData) {
      return {
        storeName: this.dataType,
        success: true,
        action: "no_action_needed",
        details: "Private data operations are disabled",
      };
    }

    try {
      await this.downloadPrivateDataFromS3();
      return {
        storeName: this.dataType,
        success: true,
        action: "downloaded",
        details: "Data downloaded from S3",
      };
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") {
        console.log("No such object", this.dataType);
        await this.forceUploadToBackend();
        return {
          storeName: this.dataType,
          success: true,
          action: "uploaded",
          details: "Error downloading from backend(NoSuchKey), uploaded to S3",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      } else {
        console.error("Error downloading from backend:", error);
        return {
          storeName: this.dataType,
          success: false,
          action: "no_action_needed",
          details: "Error downloading from backend",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  }

  /**
   * Force merge local and S3 data
   */
  public async forceMergeWithBackend(): Promise<{
    storeName: string;
    success: boolean;
    action: "downloaded" | "uploaded" | "no_action_needed";
    details: string;
    error?: string;
  }> {
    if (!this.usePrivateData) {
      return {
        storeName: this.dataType,
        success: true,
        action: "no_action_needed",
        details: "Private data operations are disabled",
      };
    }

    try {
      await this.mergePrivateDataAndS3();
      return {
        storeName: this.dataType,
        success: true,
        action: "downloaded",
        details: "Data merged successfully",
      };
    } catch (error) {
      console.error("Error merging with backend:", error);
      return {
        storeName: this.dataType,
        success: false,
        action: "no_action_needed",
        details: "Error merging with backend",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Sync private data and input data with the backend
   * Simplified logic based on S3 last modified time, local private data updated time, and write counter
   * Implements 5-second debounce to prevent excessive sync calls and batch rapid requests
   */
  public async syncWithDebounce(debounceTime: number = 1000): Promise<{
    storeName: string;
    success: boolean;
    action: "downloaded" | "uploaded" | "no_action_needed";
    details: string;
    error?: string;
  }> {
    if (!this.usePrivateData) {
      return {
        storeName: this.dataType,
        success: true,
        action: "no_action_needed",
        details: "This data type does not have private data",
      };
    }

    // Clear any existing debounce timer for this storeName
    const existingTimer = StorageManager.debounceTimers.get(this.dataType);
    if (existingTimer) {
      clearTimeout(existingTimer);
      StorageManager.debounceTimers.delete(this.dataType);
      console.log(
        `Cleared existing debounce timer for storeName: ${this.dataType}`
      );
    }

    // Create a new debounced sync promise
    return new Promise((resolve) => {
      const debounceTimer = setTimeout(async () => {
        try {
          console.log(
            `Executing debounced sync for storeName: ${this.dataType}`
          );
          const result = await this.sync();
          resolve(result);
        } catch (error) {
          resolve({
            storeName: this.dataType,
            success: false,
            action: "no_action_needed",
            details: "Debounced sync failed",
            error: error instanceof Error ? error.message : "Unknown error",
          });
        } finally {
          // Clean up the debounce timer
          StorageManager.debounceTimers.delete(this.dataType);
        }
      }, debounceTime);

      // Store the timer for potential cleanup
      StorageManager.debounceTimers.set(this.dataType, debounceTimer);
      console.log(
        `Set ${debounceTime}ms debounce timer for storeName: ${this.dataType}`
      );
    });
  }

  /**
   * Clear debounce timer for this data type
   * Useful for cleanup or when immediate sync is needed
   */
  public clearDebounceTimer(): void {
    const existingTimer = StorageManager.debounceTimers.get(this.dataType);
    if (existingTimer) {
      clearTimeout(existingTimer);
      StorageManager.debounceTimers.delete(this.dataType);
      console.log(`Cleared debounce timer for storeName: ${this.dataType}`);
    }
  }

  /**
   * Clear all debounce timers across all data types
   * Useful for cleanup when shutting down the application
   */
  public static clearAllDebounceTimers(): void {
    StorageManager.debounceTimers.forEach((timer, storeName) => {
      clearTimeout(timer);
      console.log(`Cleared debounce timer for storeName: ${storeName}`);
    });
    StorageManager.debounceTimers.clear();
  }

  /**
   * Internal method that performs the actual sync operation
   */
  public async sync(): Promise<{
    storeName: string;
    success: boolean;
    action: "downloaded" | "uploaded" | "no_action_needed";
    details: string;
    error?: string;
  }> {
    try {
      // Get device keys from metadata and S3
      const { lastUsedDevice: s3DeviceKey, lastUpdated: s3LastUpdated } =
        await this.getLastUsedDeviceFromS3();
      const localDeviceKey = await this.getDeviceKey();
      const localLastUpdated = await this.getPrivateDataLastUpdatedTime();

      console.log("sync", this.dataType);
      console.log("Sync comparison - Local device key:", localDeviceKey);
      console.log("Sync comparison - S3 device key:", s3DeviceKey);
      console.log(
        "Sync comparison - Local last updated:",
        localLastUpdated,
        this.dataType
      );
      console.log(
        "Sync comparison - S3 last updated:",
        s3LastUpdated,
        this.dataType
      );

      // If both device keys are the same, no sync needed
      const time_difference =
        s3LastUpdated && localLastUpdated
          ? Math.abs(s3LastUpdated - localLastUpdated)
          : 0;
      if (s3DeviceKey && localDeviceKey === s3DeviceKey) {
        if (time_difference < 1000) {
          console.log(
            "syncWithoutLock: Device keys match, data is in sync",
            this.dataType
          );
          return {
            storeName: this.dataType,
            success: true,
            action: "no_action_needed",
            details: "Device keys match, data is in sync",
          };
        } else if (s3LastUpdated && s3LastUpdated > localLastUpdated) {
          console.log(
            "syncWithoutLock: Local is older than S3, downloading from S3",
            this.dataType
          );
          const downloadResult = await this.forceDownloadFromBackend();
          if (downloadResult.success) {
            await this.saveLastUsedDeviceToS3(localDeviceKey);
          }
          return {
            storeName: this.dataType,
            success: downloadResult.success,
            action: downloadResult.action,
            details:
              "Device keys match, local is older, downloading from S3: " +
              downloadResult.details,
          };
        } else {
          console.log(
            "syncWithoutLock: Local is newer than S3, uploading to S3",
            this.dataType,
            time_difference
          );
          const uploadResult = await this.forceUploadToBackend();
          if (uploadResult.success) {
            await this.saveLastUsedDeviceToS3(localDeviceKey);
          }
          return {
            storeName: this.dataType,
            success: uploadResult.success,
            action: uploadResult.action,
            details:
              "Device keys match, local is newer, uploading to S3: " +
              uploadResult.details,
          };
        }
      }

      // If S3 has a different device key, download from S3
      else if (s3DeviceKey && localDeviceKey !== s3DeviceKey) {
        console.log(
          "syncWithoutLock: S3 has different device key, downloading from S3",
          this.dataType
        );
        const downloadResult = await this.forceDownloadFromBackend();
        if (downloadResult.success) {
          await this.saveLastUsedDeviceToS3(localDeviceKey);
        }
        return {
          storeName: this.dataType,
          success: downloadResult.success,
          action: downloadResult.action,
          details:
            "S3 has different device key, downloading from S3: " +
            downloadResult.details,
        };
      }

      // If local has device key but S3 doesn't, or local is newer, upload to S3
      else {
        console.log(
          "syncWithoutLock: Local has device key, uploading to S3",
          this.dataType
        );
        const uploadResult = await this.forceUploadToBackend();
        if (uploadResult.success) {
          await this.saveLastUsedDeviceToS3(localDeviceKey);
        }
        return {
          storeName: this.dataType,
          success: uploadResult.success,
          action: uploadResult.action,
          details:
            "No S3 device key, uploading to S3: " +
            uploadResult.details +
            " localDeviceKey: " +
            localDeviceKey +
            " s3DeviceKey: " +
            s3DeviceKey,
        };
      }
    } catch (error) {
      console.log(
        "syncWithoutLock: Error syncing private data with backend:",
        error,
        this.dataType
      );
      return {
        storeName: this.dataType,
        success: false,
        action: "no_action_needed",
        details: "Error syncing private data with backend",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      this.clearOrphanedData();
    }
  }

  /**
   * Merge private data from S3 and local storage
   * Uses the larger lastModified timestamp as priority when there are conflicts
   */
  private async mergePrivateDataAndS3(): Promise<void> {
    const localPrivateData = await this.getAllPrivateIndexedDBData();
    console.log("mergePrivateDataAndS3 localPrivateData", localPrivateData);
    // const localInputData = await this.getAllInputIndexedDBData();
    try {
      // Download S3 data
      console.log("xxxx downloading S3 data", this.getS3PrivatePathFunction());
      const s3DataResult = await downloadData({
        path: this.getS3PrivatePathFunction(),
      }).result;
      const text = await s3DataResult.body.text();
      const s3DataObj = JSON.parse(text);
      if (!s3DataObj || !s3DataObj.privateData) {
        throw new Error("Invalid S3 sync data format");
      }

      // Populate S3 data map
      const s3PrivateDataMap = new Map<
        string,
        IndexedDBPrivateData<PrivateData>
      >();
      for (const item of s3DataObj.privateData) {
        if (item.key && item.data) {
          s3PrivateDataMap.set(this.getInputId(item.key), {
            key: item.key,
            userId: item.userId,
            learnerId: item.learnerId,
            lastRead: item.lastRead || Date.now(),
            lastModified: item.lastModified || Date.now(),
            data: item.data as PrivateData,
            createdAt: item.createdAt || Date.now(),
            dataType: item.dataType || this.dataType,
            deleted: item.deleted || false,
          });
        }
      }

      // Populate local data map
      const localPrivateDataMap = new Map<
        string,
        IndexedDBPrivateData<PrivateData>
      >();
      for (const item of localPrivateData) {
        localPrivateDataMap.set(this.getInputId(item.key), item);
      }

      // Add/update with local data where local is newer
      const mergedPrivateDataMap = this.mergeData(
        s3PrivateDataMap,
        localPrivateDataMap
      );

      // Clear existing private data
      const privateDataResult = await this.clearAllPrivateData(false);
      if (!privateDataResult.success) {
        throw new Error("Failed to clear private data");
      }

      // Store merged data
      for (const [key, item] of mergedPrivateDataMap) {
        await this.setPrivateIndexedDBData(
          item as IndexedDBPrivateData<PrivateData>,
          false
        );
      }

      // Upload merged data to S3
      const resolvedPrivateData = await this.getAllPrivateIndexedDBData();
      // const resolvedInputData = await this.getAllInputIndexedDBData();
      await this.uploadPrivateDataToS3(resolvedPrivateData);

      console.log(
        `Successfully merged and uploaded data: ${mergedPrivateDataMap.size} private items`,
        this.dataType
      );
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") {
        console.log("No such object", this.dataType);
        await this.uploadPrivateDataToS3(localPrivateData);
      } else {
        console.error("Error merging data from S3 and local:", error);
      }
    }
  }

  private mergeData(
    s3DataMap: Map<string, IndexedDBPrivateData<PrivateData>>,
    localDataMap: Map<string, IndexedDBPrivateData<PrivateData>>
  ): Map<string, IndexedDBPrivateData<PrivateData>> {
    const mergedData = new Map<string, IndexedDBPrivateData<PrivateData>>();
    for (const [key, s3Item] of s3DataMap) {
      mergedData.set(key, s3Item);
    }
    console.log("mergeData s3DataMap", s3DataMap);
    console.log("mergeData localDataMap", localDataMap);
    // Add/update with local data where local is newer
    const resolvedDataSet = new Set<string>();
    for (const [key, localItem] of localDataMap) {
      if (resolvedDataSet.has(key)) continue;
      resolvedDataSet.add(key);
      const s3Item = s3DataMap.get(key);
      localItem.lastModified = localItem.lastModified || 0;
      localItem.deleted = localItem.deleted || false;
      console.log("mergeData s3Item", s3Item);
      console.log("mergeData localItem", localItem);
      console.log("mergeData s3Item.lastModified", s3Item?.lastModified);
      console.log("mergeData localItem.lastModified", localItem.lastModified);

      // Both exist
      if (s3Item) {
        s3Item.lastModified = s3Item.lastModified || 0;
        s3Item.deleted = s3Item.deleted || false;
        if (s3Item.lastModified > localItem.lastModified) {
          if (s3Item.deleted) {
            console.log("mergeData s3Item delete 1", key, s3Item);
            mergedData.delete(key);
          } else {
            console.log("mergeData s3Item set 2", key, s3Item);
            mergedData.set(key, s3Item);
          }
        } else {
          if (localItem.deleted) {
            console.log("mergeData localItem delete 3", key, localItem);
            mergedData.delete(key);
          } else {
            console.log("mergeData localItem set 4", key, localItem);
            mergedData.set(key, localItem);
          }
        }
        // Only local exists
      } else {
        if (localItem.deleted) {
          console.log("mergeData localItem delete 5", key, localItem);
          mergedData.delete(key);
        } else {
          console.log("mergeData localItem set 6", key, localItem);
          mergedData.set(key, localItem);
        }
      }
    }
    // Only S3 exists
    for (const [key, s3Item] of s3DataMap) {
      console.log("mergeData s3Item", s3Item);
      console.log("mergeData s3Item.lastModified", s3Item?.lastModified);
      if (resolvedDataSet.has(key)) continue;
      resolvedDataSet.add(key);
      if (s3Item.deleted) {
        console.log("mergeData s3Item delete 7", key);
        mergedData.delete(key);
      } else {
        console.log("mergeData s3Item set 8", key);
        mergedData.set(key, s3Item);
      }
    }
    return mergedData;
  }

  /**
   * Download private data and input data from S3 and update local storage
   */
  private async downloadPrivateDataFromS3(): Promise<void> {
    try {
      if (!this.usePrivateData) return;
      console.log(
        "xxxx downloadPrivateDataFromS3 > downloadData",
        this.getS3PrivatePathFunction()
      );
      const s3DataResult = await downloadData({
        path: this.getS3PrivatePathFunction(),
      }).result;
      const text = await s3DataResult.body.text();
      const s3DataObj = JSON.parse(text);
      if (!s3DataObj) {
        throw new Error("No S3 sync data found");
      }

      // Type assertion for sync data structure
      const syncData = s3DataObj as any;
      if (!syncData.privateData) {
        console.log("xxxx syncData", syncData);
        throw new Error("Invalid S3 sync data format");
      }

      // Clear existing private data
      await this.clearAllPrivateData(false);

      // Import the private data from S3
      console.log("Importing private data from S3", syncData.privateData);
      for (const privateDataItem of syncData.privateData) {
        if (privateDataItem.key && privateDataItem.data && this.userId) {
          await this.setPrivateIndexedDBData(
            {
              key: privateDataItem.key,
              learnerId: privateDataItem.learnerId!,
              userId: this.userId,
              lastRead: Date.now(),
              lastModified: Date.now(),
              data: privateDataItem.data as PrivateData,
              createdAt: privateDataItem.createdAt || Date.now(),
              dataType: this.dataType,
              deleted: privateDataItem.deleted || false,
            },
            false
          );
        }
      }

      console.log(
        "Successfully downloaded and imported data from S3",
        this.dataType
      );
    } catch (error) {
      throw error;
    }
  }

  /**
   * Upload private data and input data to S3
   */
  private async uploadPrivateDataToS3(
    privateData: IndexedDBPrivateData<PrivateData>[]
  ): Promise<void> {
    try {
      const syncData = {
        lastModified: Date.now(),
        privateData: privateData,
        userId: this.userId,
        privateTotal: privateData.length,
        totalItems: privateData.length,
      };

      // Use the existing setS3Data method but with a custom data structure
      console.log("xxxx uploadPrivateDataToS3 > uploadData", syncData);
      const uploadResult = await uploadData({
        path: this.getS3PrivatePathFunction(),
        data: JSON.stringify(syncData),
        options: {
          contentType: "application/json",
        },
      }).result;

      console.log("xxxx uploadResult", uploadResult);
      await this.savePrivateDataLastUpdatedTime(Date.now());

      console.log("Successfully uploaded private data to S3", this.dataType);
    } catch (error) {
      console.error(
        "Error uploading private data to S3:",
        this.dataType,
        error
      );
      throw error;
    }
  }

  /**
   * Clear all private data for the current user.
   * This will clear all private data from IndexedDB for the current user
   */
  public async clearAllPrivateDataForLearner(): Promise<{
    success: boolean;
    deletedCount: number;
    error?: string;
  }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }
    if (!this.useLearnerId) {
      return { success: true, deletedCount: 0 };
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.privateStoreName],
        "readwrite"
      );
      let deletedCount = 0;
      const store = transaction.objectStore(this.privateStoreName);
      const index = store.index(this.index_userId);
      const request = index.openCursor(IDBKeyRange.only(this.userId));

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const record = cursor.value;
          // Only delete if it belongs to current storeName
          if (
            record.dataType === this.dataType &&
            record.learnerId === this.currentLearner?.id
          ) {
            console.log(
              "clearAllPrivateDataForLearner delete",
              cursor.primaryKey
            );
            store.delete(cursor.primaryKey);
            deletedCount++;
          }
          cursor.continue();
        } else {
          this.savePrivateDataLastUpdatedTime(Date.now());
          this.syncWithDebounce();
          resolve({ success: true, deletedCount: deletedCount });
        }
      };
    });
  }

  /**
   * Clear all private data for the current user.
   * This will clear all private data from IndexedDB for the current user
   */
  /**
   * Clear private data for the current user, or for all data NOT belonging to the current user.
   * @param syncWithS3 - Whether to sync with S3 after deletion.
   * @param clearDataNotUserId - If true, clear all data NOT belonging to the current userId; if false, clear only for current userId.
   */
  public async clearAllPrivateData(
    syncWithS3: boolean,
    clearDataNotUserId: boolean = false
  ): Promise<{
    success: boolean;
    deletedCount: number;
    error?: string;
  }> {
    if (!this.usePrivateData) {
      return { success: true, deletedCount: 0 };
    }
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }
    if (!this.userId) {
      await this.initUserId();
      if (!this.userId) {
        console.error("User ID not initialized");
        throw new Error("User ID not initialized");
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.privateStoreName],
        "readwrite"
      );
      let deletedCount = 0;
      const store = transaction.objectStore(this.privateStoreName);
      // Always use a full scan, since we may want to delete "not userId"
      const request = store.openCursor();
      console.log(
        "clearAllPrivateData",
        clearDataNotUserId ? "deleting NOT userId" : "deleting userId",
        this.userId,
        this.dataType
      );

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const record = cursor.value;
          // Only delete if it belongs to current storeName
          if (
            record.dataType === this.dataType &&
            ((clearDataNotUserId && record.userId !== this.userId) ||
              (!clearDataNotUserId && record.userId === this.userId))
          ) {
            console.log(
              "clearAllPrivateData delete",
              cursor.primaryKey,
              record.userId
            );
            store.delete(cursor.primaryKey);
            deletedCount++;
          }
          cursor.continue();
        } else {
          if (syncWithS3) {
            this.savePrivateDataLastUpdatedTime(Date.now());
            this.syncWithDebounce();
          }
          resolve({ success: true, deletedCount: deletedCount });
        }
      };
    });
  }

  /**
   * Clear all public data for the current store
   * This will clear all public data from IndexedDB for the current user
   */
  public async clearAllPublicData(): Promise<{
    success: boolean;
    deletedCount: number;
    error?: string;
  }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.publicStoreName],
        "readwrite"
      );
      let deletedCount = 0;
      const store = transaction.objectStore(this.publicStoreName);
      const index = store.index(this.index_dataType);
      const request = index.openCursor(IDBKeyRange.only(this.dataType));

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const record = cursor.value;
          // Only delete if it belongs to current storeName
          if (record.dataType === this.dataType) {
            console.log("clearAllPublicData delete", cursor.primaryKey);
            store.delete(cursor.primaryKey);
            deletedCount++;
          }
          cursor.continue();
        } else {
          resolve({ success: true, deletedCount: deletedCount });
        }
      };
    });
  }

  /**
   * Clear all metadata data for the current store
   * This will clear all metadata data from IndexedDB for the current user
   */
  public async clearAllMetadataData(
    clearDataNotUserId: boolean = false
  ): Promise<{
    success: boolean;
    deletedCount: number;
    error?: string;
  }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        console.error("IndexedDB not initialized");
        throw new Error("IndexedDB not initialized");
      }
    }
    if (!this.userId) {
      await this.initUserId();
      if (!this.userId) {
        console.error("User ID not initialized");
        throw new Error("User ID not initialized");
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.metadataStoreName],
        "readwrite"
      );
      let deletedCount = 0;
      const store = transaction.objectStore(this.metadataStoreName);
      // Always use a full scan, since we may want to delete "not userId"
      const request = store.openCursor();
      console.log(
        "clearAllMetadataData",
        clearDataNotUserId ? "deleting NOT userId" : "deleting userId",
        this.userId,
        this.dataType
      );

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const record = cursor.value;
          // Only delete if it belongs to current storeName
          if (
            record.dataType === this.dataType &&
            ((clearDataNotUserId && record.userId !== this.userId) ||
              (!clearDataNotUserId && record.userId === this.userId))
          ) {
            console.log("clearAllMetadataData delete", cursor.primaryKey);
            store.delete(cursor.primaryKey);
            deletedCount++;
          }
          cursor.continue();
        } else {
          resolve({ success: true, deletedCount: deletedCount });
        }
      };
    });
  }

  public async clearOrphanedData(): Promise<{
    success: boolean;
    deletedCount: number;
    error?: string;
  }> {
    try {
      // Get all learner IDs by querying learner data directly from IndexedDB
      const learnerData = await this.getAllPrivateLearnerIndexedDBData();
      const validLearnerIds = new Set(
        learnerData
          .map((item) => this.getInputId(item.key))
          .filter((id): id is string => id !== null)
      );

      console.log("Valid learner IDs:", Array.from(validLearnerIds));

      // Get all private data from all data types directly from IndexedDB
      const allPrivateData = await this.getAllPrivateIndexedDBData();
      let totalDeletedCount = 0;

      try {
        console.log(`Processing ${allPrivateData.length} items...`);

        const orphanedItems = allPrivateData.filter((item) => {
          const learnerId = item.learnerId;
          const isLearner = item.dataType === PATHS.LEARNER.DATA_TYPE;
          return !isLearner && learnerId && !validLearnerIds.has(learnerId);
        });

        console.log(
          `Found ${orphanedItems.length} orphaned items in ${allPrivateData.length}`
        );

        // Delete orphaned items directly from IndexedDB
        for (const item of orphanedItems) {
          try {
            await this.deletePrivateDataByKeyDirect(item.key);
            totalDeletedCount++;
          } catch (deleteError) {
            console.error(
              `Failed to delete item ${item.key} from ${allPrivateData.length}:`,
              deleteError
            );
          }
        }
      } catch (dataTypeError) {
        console.error(
          `Error processing ${allPrivateData.length} data type:`,
          dataTypeError
        );
      }

      console.log(`Cleared ${totalDeletedCount} orphaned data items`);

      return {
        success: true,
        deletedCount: totalDeletedCount,
      };
    } catch (error) {
      console.error("Error in clearOrphanedData:", error);
      return {
        success: false,
        deletedCount: 0,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Delete private data directly from IndexedDB by key
   * @param key - The key to delete
   * @returns Promise<boolean> - Success status
   */
  private async deletePrivateDataByKeyDirect(
    key: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.db) {
      await this.initIndexedDB();
      if (!this.db) {
        throw new Error("Failed to initialize IndexedDB");
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.privateStoreName],
        "readwrite"
      );
      const store = transaction.objectStore(this.privateStoreName);
      const request = store.delete(key);

      request.onerror = () => {
        console.error(`Failed to delete key ${key}:`, request.error);
        reject(request.error);
      };
      request.onsuccess = () => {
        this.savePrivateDataLastUpdatedTime(Date.now());
        this.syncWithDebounce();
        resolve({ success: true });
      };
    });
  }

  /**
   * Get the last used device key from S3
   * @returns Promise<string | null> - The last used device key or null if not found
   */
  private async getLastUsedDeviceFromS3(): Promise<{
    lastUsedDevice: string | null;
    lastUpdated: number | null;
  }> {
    try {
      const s3Path = this.getS3DevicePathFunction();
      console.log("getLastUsedDeviceFromS3 - S3 Path:", s3Path);
      console.log("getLastUsedDeviceFromS3 - Data Type:", this.dataType);
      console.log("getLastUsedDeviceFromS3 - Timestamp:", new Date().toISOString());
      
      const s3DataResult = await downloadData({
        path: s3Path,
        options: {
          // Add cache-busting to prevent stale data
          useAccelerateEndpoint: false,
          // Force fresh data by adding a timestamp query parameter
          // Note: This might not work with all S3 configurations
        }
      }).result;
      
      console.log(
        "getLastUsedDeviceFromS3 s3DataResult",
        s3DataResult,
        this.dataType
      );
      
      // Log response headers to check for caching
      console.log("getLastUsedDeviceFromS3 - Response Headers:", s3DataResult.metadata);
      
      const s3Data = await s3DataResult.body.text();
      console.log("getLastUsedDeviceFromS3 s3Data", s3Data, this.dataType);
      const s3DataObj = JSON.parse(s3Data);
      console.log(
        "getLastUsedDeviceFromS3 s3DataObj",
        s3DataObj,
        this.dataType
      );
      if (!s3DataObj.lastUsedDevice || !s3DataObj.lastUpdated) {
        return {
          lastUsedDevice: null,
          lastUpdated: null,
        };
      }
      return {
        lastUsedDevice: s3DataObj.lastUsedDevice,
        lastUpdated: s3DataObj.lastUpdated,
      };
    } catch (error) {
      console.log("getLastUsedDeviceFromS3 - Error details:", error);
      if (
        (error instanceof Error && error.name === "NotFound") ||
        (error instanceof Error && error.name === "NoSuchKey")
      ) {
        console.log("No device key found in S3");
        return {
          lastUsedDevice: null,
          lastUpdated: null,
        };
      } else if (error instanceof Error && error.name === "AccessDenied") {
        console.log("Access denied to get device key from S3");
        throw error;
      } else {
        console.log("Error getting device key from S3");
        throw error;
      }
    }
  }

  /**
   * Save the last used device key to S3
   * @param deviceKey - The device key to save
   */
  private async saveLastUsedDeviceToS3(deviceKey: string): Promise<void> {
    try {
      const lastUpdated = await this.getPrivateDataLastUpdatedTime();
      const deviceData = {
        lastUsedDevice: deviceKey,
        lastUpdated: lastUpdated == 0 ? Date.now() : lastUpdated,
      };

      const uploadResult = await uploadData({
        path: this.getS3DevicePathFunction(),
        data: JSON.stringify(deviceData),
        options: {
          contentType: "application/json",
        },
      }).result;

      console.log("debug: saveLastUsedDeviceToS3: uploadResult", uploadResult);
      console.log("Device key saved to S3:", deviceKey);
    } catch (error) {
      console.error("Error saving device key to S3:", error);
      throw error;
    }
  }

  /**
   * Create or get device key and store it in the metadata store
   * @returns Promise<string> - The device key
   */
  public async getDeviceKey(): Promise<string> {
    try {
      if (!this.db) {
        await this.initIndexedDB();
      }

      const deviceKeyKey =
        "deviceKey" + this.dataType[0].toUpperCase() + this.dataType.slice(1);
      const currentTime = Date.now();

      // First, try to get existing device key
      const transaction = this.db!.transaction(
        [this.metadataStoreName],
        "readwrite"
      );
      const store = transaction.objectStore(this.metadataStoreName);
      const getRequest = store.get(deviceKeyKey);

      return new Promise((resolve, reject) => {
        getRequest.onsuccess = () => {
          if (getRequest.result) {
            // Device key exists, update lastUsed and return it
            const existingData =
              getRequest.result as IndexedDBMetadata<DeviceKeyMetadata>;
            const updatedData: IndexedDBMetadata<DeviceKeyMetadata> = {
              ...existingData,
              lastRead: currentTime,
              data: {
                ...existingData.data,
                lastUsed: currentTime,
              },
            };

            const updateRequest = store.put(updatedData);
            updateRequest.onsuccess = () => {
              console.log(
                "Device key retrieved and updated:",
                existingData.data.deviceKey
              );
              resolve(existingData.data.deviceKey);
            };
            updateRequest.onerror = () => {
              console.error(
                "Failed to update device key:",
                updateRequest.error
              );
              reject(updateRequest.error);
            };
          } else {
            // Device key doesn't exist, create a new one using UUID
            const deviceKey = crypto.randomUUID();
            const deviceKeyData: DeviceKeyMetadata = {
              deviceKey,
              createdAt: currentTime,
              lastUsed: currentTime,
            };

            const metadataEntry: IndexedDBMetadata<DeviceKeyMetadata> = {
              key: deviceKeyKey,
              userId: this.userId || "anonymous",
              lastRead: currentTime,
              createdAt: currentTime,
              data: deviceKeyData,
              dataType: this.dataType,
            };

            const putRequest = store.put(metadataEntry);
            putRequest.onsuccess = () => {
              console.log("Device key created and stored:", deviceKey);
              resolve(deviceKey);
            };
            putRequest.onerror = () => {
              console.error("Failed to create device key:", putRequest.error);
              reject(putRequest.error);
            };
          }
        };

        getRequest.onerror = () => {
          console.error("Failed to get device key:", getRequest.error);
          reject(getRequest.error);
        };

        transaction.onerror = () => {
          console.error(
            "Transaction error in createOrGetDeviceKey:",
            transaction.error
          );
          reject(transaction.error);
        };
      });
    } catch (error) {
      console.error("Error in createOrGetDeviceKey:", error);
      throw error;
    }
  }
}

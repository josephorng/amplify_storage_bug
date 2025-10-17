// Separate interfaces for public and private data
export interface IndexedDBPublicData<PublicData> {
  key: string;
  lastS3Modified: number;
  lastS3Sync: number;
  lastRead: number;
  createdAt: number;
  data: PublicData;
  storeName: string;
}

export interface IndexedDBPrivateData<PrivateData> {
  key: string;
  userId: string;
  learnerId: string;
  lastRead: number;
  lastModified: number;
  createdAt: number;
  data: PrivateData;
  dataType: string;
  deleted: boolean;
}

// New interface for input data storage
export interface IndexedDBInputData<inputType> {
  key: string;
  userId: string;
  lastRead: number;
  lastModified: number;
  createdAt: number;
  data: inputType;
  dataType: string;
  deleted: boolean;
}

export interface IndexedDBMetadata<Metadata> {
  key: string;
  userId: string;
  lastRead: number;
  createdAt: number;
  data: Metadata;
  dataType: string;
}

// Device key metadata type
export interface DeviceKeyMetadata {
  deviceKey: string;
  createdAt: number;
  lastUsed: number;
}

// Input type: [role, text]
export interface MessageInput extends ModelInput {
  response_id: string; // Unique
  role: "user" | "ai";
  createdAt: number;
  conversationId: string;
  type: "transcriptMessage" | "typedMessage" | "repeatSentence" | "aiResponse";
}

// Private type: [correction, response_id, conversationId, type]
export interface MessagePrivateData extends MessageInput {
  text: string;
  correction?: string; // Depends on the context
  translatedText?: string; // User's input is unsure, ai's response will be get from sentenceInfo
  transliteratedText?: string;
}

export interface MessageSidebarItemData
  extends MessageInput,
    MessagePrivateData {
  id: string;
  createdAt: number;
}

// Public type: empty array (no public data needed for messages)
export type MessagePublicData = never;

// Input type: [topic, type, nativeLanguage, learningLanguage, level, aiGender, userGender]
export interface ConversationInput {
  type: "dialogue" | "lesson";
  nativeLanguage: string;
  learningLanguage: string;
  createdAt: number;
}

// Private type: [messages]
export interface ConversationPrivateData extends ConversationInput {
  topic: string | null;
  level:
    | "Beginner"
    | "Elementary"
    | "Intermediate"
    | "UpperIntermediate"
    | "Advanced"
    | "Proficient";
  aiGender: "MALE" | "FEMALE";
  userGender: "MALE" | "FEMALE";
  hashTags: string[];
  messages: string[]; // Array of message IDs or keys
}

// Public type: empty (no public data needed for conversations)
export type ConversationPublicData = never;

export interface ConversationSidebarItemData
  extends ConversationInput,
    ConversationPrivateData {
  id: string;
  createdAt: number;
}

// Input type for learner storage (createdAt timestamp)
export type LearnerInputType = {
  createdAt: number;
};

// Private data type for learner storage
export interface LearnerPrivateData extends LearnerInputType {
  name: string;
  nativeLanguage: string;
  learningLanguage: string;
  aiGender: "MALE" | "FEMALE";
  userGender: "MALE" | "FEMALE";
  level:
    | "Beginner"
    | "Elementary"
    | "Intermediate"
    | "UpperIntermediate"
    | "Advanced"
    | "Proficient";
  lastUsed: number;
  dialogueModel: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5";
  lessonModel: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5";
  sentenceHelpModel: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5";
  sentenceInfoModel: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5";
  vocabHelpModel: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5";
  vocabInfoModel: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5";
  transliterationModel: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5";
  voiceAiModel: "gcp-standard";
};

// Public data type for learner storage (empty for now)
export type LearnerPublicData = never;

export interface LearnerSidebarItemData
  extends LearnerPrivateData,
    LearnerInputType {
  id: string;
  createdAt: number;
}

export interface ModelInput {
  model: "gpt-5-nano" | "gpt-4.1-nano" | "gpt-5-mini" | "gpt-5" | "gcp-standard";
}

// Define the input structure for creating/retrieving sentence help
export interface SentenceHelpInput extends ModelInput {
  sentence: string;
  sentenceLanguage: string;
  explanationLanguage: string;
}

// Define the sentence help data structure
export interface SentenceHelpPublicData extends SentenceHelpInput {
  help: string;
  grammar: string;
  similarSentences: string[];
}

// Define the input structure for creating/retrieving sentence info
export interface SentenceInfoInput extends ModelInput {
  text: string;
  sentenceLanguage: string;
  translateLanguage: string;
}

// Define the sentence info data structure
export interface SentencePublicData extends SentenceInfoInput {
  translation: string;
  alternatives: string[];
}

export interface SentencePrivateData extends SentenceInfoInput {
  isReviewItem: boolean;
  learned: boolean;
  reviewTime: number;
  lastReviewDate: string;
  gender: "MALE" | "FEMALE";
}

export interface SentenceSidebarItemData
  extends SentenceInfoInput,
    SentencePublicData,
    SentencePrivateData {
  id: string;
  createdAt: number;
}

// Define the input structure for creating/retrieving vocabulary help
export interface VocabHelpInput extends ModelInput {
  word: string;
  language: string;
  explanationLanguage: string;
}

// Define the vocabulary help data structure
export interface VocabHelpPublicData extends VocabHelpInput {
  help: string;
}

// Define the input structure for creating/retrieving vocabulary info
export interface VocabInput extends ModelInput {
  vocabLanguage: string;
  translateLanguage: string;
  context: string;
  text: string;
  position: number;
}

// Define the vocabulary info data structure
export interface VocabPublicData extends VocabInput {
  translatedText: string;
  baseText: string;
  synonyms: string[];
}

export interface VocabPrivateData extends VocabInput {
  isReviewItem: boolean;
  learned: boolean;
  reviewTime: number;
  lastReviewDate: string;
  gender: "MALE" | "FEMALE";
}

export interface VocabSidebarItemData
  extends VocabPublicData,
    VocabPrivateData,
    VocabInput {
  id: string;
  createdAt: number;
}

export interface VoiceAiInput extends ModelInput {
  text: string;
  language: string;
  gender: "MALE" | "FEMALE";
}

export interface VoiceAiPublicData extends VoiceAiInput {
  blob: Blob | null;
}

export interface VoiceUserInput {
  text: string;
}

export interface VoiceUserPrivateData extends VoiceUserInput {
  blob: Blob | null;
}

// ----- News -----

// News data types based on the existing news system
export interface NewsArticle {
  title: string;
  description?: string;
  link?: string;
  published?: string;
  list_items?: string[];
  source?: string;
  [key: string]: any;
}

export interface NewsMetadata {
  news_id: string;
  source_ceid: string;
  country: string;
  shortTitle: string;
  titleEnglish: string;
  source: string;
  link: string;
  published: string;
  summary: string;
  beginnerSummary: string;
  imagePrompt: string;
  imageKey: string;
  imageBlob: Blob | null;
  audioKey: string;
  audioBlob: Blob | null;
  audioKeyBeginner: string;
  audioBeginnerBlob: Blob | null;
  originalArticle: NewsArticle;
  pseReport?: string;
  snippets?: NewsSnippet[];
  snippetsText?: string;
  snippetSummary?: string;
  snippetBeginnerSummary?: string;
}

export interface NewsSnippet {
  title: string;
  content?: string;
  description?: string;
  link?: string;
  published?: string;
  source?: string;
  relevanceScore?: number;
}

// Input type for news storage (used as key for storage)
export interface NewsInput {
  gcp_language_code: string;
  date: string;
}

// Public data type (the actual news content)
export interface NewsPublicData extends NewsInput {
  newsList: NewsMetadata[];
};

// Private data type (empty since we don't use private data)
export type NewsPrivateData = never;

// Sidebar item data for news
export interface NewsSidebarItemData extends NewsMetadata, NewsInput {
  id: string;
  createdAt: number;
}

// ----- Transliteration -----

// Input type for transliteration storage
export interface TransliterationInput extends ModelInput {
  text: string;
  language: string;
}

// Public data type for transliteration results
export interface TransliterationPublicData extends TransliterationInput {
  transliteratedText: string;
}

// Private data type (empty since we don't use private data for transliteration)
export type TransliterationPrivateData = never;

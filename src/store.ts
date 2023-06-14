import { createStore } from "solid-js/store"
import { defaultEnv } from "./env"
import { type ChatMessage, LocalStorageKey } from "./types"
import { batch, createMemo, createRoot } from "solid-js"
import { countTokens, fetchAllSessions, getSession } from "./utils"
import { Fzf } from "fzf"
import type { Model, Option, SimpleModel } from "~/types"
import type MarkdownIt from "markdown-it"

let globalSettings = { ...defaultEnv.CLIENT_GLOBAL_SETTINGS }
let _ = import.meta.env.CLIENT_GLOBAL_SETTINGS
if (_) {
  try {
    globalSettings = {
      ...globalSettings,
      ...JSON.parse(_)
    }
  } catch (e) {
    console.error("Error parsing CLIENT_GLOBAL_SETTINGS:", e)
  }
}

let sessionSettings = { ...defaultEnv.CLIENT_SESSION_SETTINGS }
_ = import.meta.env.CLIENT_SESSION_SETTINGS
if (_) {
  try {
    sessionSettings = {
      ...sessionSettings,
      ...JSON.parse(_)
    }
  } catch (e) {
    console.error("Error parsing CLIENT_SESSION_SETTINGS:", e)
  }
}

let maxInputTokens = defaultEnv.CLIENT_MAX_INPUT_TOKENS
_ = import.meta.env.CLIENT_MAX_INPUT_TOKENS
if (_) {
  try {
    if (Number.isNaN(+_)) {
      maxInputTokens = {
        ...maxInputTokens,
        ...JSON.parse(_)
      }
    }
  } catch (e) {
    console.error("Error parsing CLIENT_MAX_INPUT_TOKENS:", e)
  }
}

export const defaultMessage: ChatMessage = {
  role: "assistant",
  content:
    import.meta.env.CLIENT_DEFAULT_MESSAGE || defaultEnv.CLIENT_DEFAULT_MESSAGE,
  type: "default"
}

const models = {
  "gpt-3.5": {
    "4k": "gpt-3.5-turbo-0613",
    "16k": "gpt-3.5-turbo-16k-0613"
  },
  "gpt-4": {
    "8k": "gpt-4-0613",
    "32k": "gpt-4-32k-0613"
  }
} satisfies {
  [k in SimpleModel]: {
    [k: string]: Model
  }
}

const modelFee = {
  "gpt-3.5-turbo-0613": {
    input: 0.0015,
    output: 0.002
  },
  "gpt-3.5-turbo-16k-0613": {
    input: 0.003,
    output: 0.004
  },
  "gpt-4-0613": {
    input: 0.03,
    output: 0.06
  },
  "gpt-4-32k-0613": {
    input: 0.06,
    output: 0.12
  }
} satisfies {
  [key in Model]: {
    input: number
    output: number
  }
}

function Store() {
  const [store, setStore] = createStore({
    sessionId: "index",
    globalSettings,
    sessionSettings,
    inputContent: "",
    messageList: [] as ChatMessage[],
    currentAssistantMessage: "",
    loading: false,
    inputRef: null as HTMLTextAreaElement | null,
    md: null as MarkdownIt | null,
    get validContext() {
      return validContext()
    },
    get contextToken() {
      return contextToken()
    },
    get contextToken$() {
      return contextToken$()
    },
    get currentMessageToken() {
      return currentMessageToken()
    },
    get currentMessageToken$() {
      return currentMessageToken$()
    },
    get inputContentToken() {
      return inputContentToken()
    },
    get inputContentToken$() {
      return inputContentToken$()
    },
    get remainingToken() {
      return remainingToken()
    },
    get currentModel() {
      return currentModel()
    }
  })

  const validContext = createMemo(() =>
    store.sessionSettings.continuousDialogue
      ? store.messageList.filter(
          (k, i, _) =>
            (k.role === "assistant" && _[i - 1]?.role === "user") ||
            (k.role === "user" && _[i + 1]?.role !== "error")
        )
      : store.messageList.filter(k => k.type === "locked")
  )

  const contextToken = createMemo(() =>
    store.validContext.reduce((acc, cur) => acc + countTokens(cur.content), 0)
  )

  const currentMessageToken = createMemo(() =>
    countTokens(store.currentAssistantMessage)
  )

  const inputContentToken = createMemo(() => countTokens(store.inputContent))

  const remainingToken = createMemo(
    () =>
      (store.globalSettings.APIKey
        ? maxInputTokens[store.sessionSettings.model]
        : defaultEnv.CLIENT_MAX_INPUT_TOKENS[store.sessionSettings.model]) -
      store.contextToken -
      store.inputContentToken
  )

  const currentModel = createMemo(() => {
    const model = store.sessionSettings.model
    const tk = (store.inputContentToken + store.contextToken) / 1000
    if (model === "gpt-3.5") {
      return models["gpt-3.5"][tk < 3.5 ? "4k" : "16k"]
    } else {
      return models["gpt-4"][tk < 7 ? "8k" : "32k"]
    }
  })

  const inputContentToken$ = createMemo(() =>
    countTokensDollar(store.inputContentToken, store.currentModel, "input")
  )
  const contextToken$ = createMemo(() =>
    countTokensDollar(store.contextToken, store.currentModel, "input")
  )
  const currentMessageToken$ = createMemo(() =>
    countTokensDollar(store.currentMessageToken, store.currentModel, "output")
  )

  return { store, setStore }
}

export const RootStore = createRoot(Store)

export const FZFData = {
  promptOptions: [] as Option[],
  fzfPrompts: undefined as Fzf<Option[]> | undefined,
  sessionOptions: [] as Option[],
  fzfSessions: undefined as Fzf<Option[]> | undefined
}

export function loadSession(id: string) {
  const { store, setStore } = RootStore
  // 只触发一次更新
  batch(() => {
    setStore("sessionId", id)
    try {
      const globalSettings = localStorage.getItem(
        LocalStorageKey.GLOBALSETTINGS
      )
      const session = getSession(id)
      if (globalSettings) {
        const parsed = JSON.parse(globalSettings)
        setStore("globalSettings", t => ({
          ...t,
          ...parsed
        }))
      }
      if (session) {
        const { settings, messages } = session
        if (settings) {
          setStore("sessionSettings", t => ({
            ...t,
            ...settings
          }))
        }
        if (messages) {
          if (store.sessionSettings.saveSession) {
            setStore("messageList", messages)
          } else {
            setStore(
              "messageList",
              messages.filter(m => m.type === "locked")
            )
          }
        }
      }
    } catch {
      console.log("Localstorage parse error")
    }
  })
  setTimeout(() => {
    FZFData.sessionOptions = fetchAllSessions()
      .sort((m, n) => n.lastVisit - m.lastVisit)
      .filter(k => k.id !== store.sessionId && k.id !== "index")
      .map(k => ({
        title: k.settings.title,
        desc: k.messages.map(k => k.content).join("\n"),
        extra: {
          id: k.id
        }
      }))
    FZFData.fzfSessions = new Fzf(FZFData.sessionOptions, {
      selector: k => `${k.title}\n${k.desc}`
    })
  }, 500)
}

function countTokensDollar(
  tokens: number,
  model: Model,
  io: "input" | "output"
) {
  const tk = tokens / 1000
  return modelFee[model][io] * tk
}
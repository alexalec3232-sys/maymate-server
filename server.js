const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

let OpenCC = null;

try {
  OpenCC = require("opencc");
  console.log("✅ OpenCC 已加载，语音结果会尝试转成简体");
} catch (error) {
  console.log("⚠️ 未安装 opencc，语音结果将直接原样返回");
}

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, "uploads/");
  },

  filename(req, file, callback) {
    const extension =
      path.extname(file.originalname) || ".m4a";

    callback(
      null,
      `${Date.now()}${extension}`
    );
  }
});

const upload = multer({ storage });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * 模型档位。
 *
 * CORE：
 * 默认档位，使用 GPT-4.1 mini。
 *
 * PREMIUM：
 * 高级档位，使用 GPT-5.6 Terra。
 */
const MODEL_TIER = {
  CORE: "core",
  PREMIUM: "premium"
};

/**
 * 所有具体模型名称只在这里配置。
 *
 * Android 和其他业务代码只需要传：
 *
 * core
 * premium
 *
 * 不需要知道具体模型名称。
 */
const MODEL_CONFIG = {
  [MODEL_TIER.CORE]: {
    chat: "gpt-4.1-mini",
    vision: "gpt-4.1-mini"
  },

  [MODEL_TIER.PREMIUM]: {
    chat: "gpt-5.6-terra",
    vision: "gpt-5.6-terra"
  }
};

/**
 * Android 没有传 modelTier 时，
 * 默认使用便宜的 CORE 模型。
 */
const DEFAULT_MODEL_TIER =
  MODEL_TIER.CORE;

const STT_MODEL = "whisper-1";

/**
 * 清理并验证模型档位。
 *
 * 只有明确传入 premium，
 * 才允许使用 GPT-5.6。
 *
 * 其他任何值都会安全回退到 core，
 * 避免因为拼写错误意外消耗高级模型。
 */
function normalizeModelTier(modelTier) {
  const normalized =
    typeof modelTier === "string"
      ? modelTier.trim().toLowerCase()
      : "";

  if (
    normalized === MODEL_TIER.PREMIUM
  ) {
    return MODEL_TIER.PREMIUM;
  }

  return DEFAULT_MODEL_TIER;
}

/**
 * 根据模型档位和是否包含图片，
 * 选择最终调用的模型。
 */
function resolveModel({
  modelTier,
  hasImage
}) {
  const normalizedTier =
    normalizeModelTier(modelTier);

  const config =
    MODEL_CONFIG[normalizedTier];

  return {
    tier: normalizedTier,

    model: hasImage
      ? config.vision
      : config.chat
  };
}

async function toSimplifiedChinese(text) {
  if (!text) {
    return "";
  }

  if (!OpenCC) {
    return text;
  }

  try {
    const converter =
      new OpenCC("t2s.json");

    return await converter.convertPromise(
      text
    );
  } catch (error) {
    console.log(
      "⚠️ 简繁转换失败，返回原文：",
      error?.message || error
    );

    return text;
  }
}

function safeDeleteFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // 文件不存在或删除失败时忽略。
  }
}

function detectImageMimeType(base64) {
  if (
    !base64 ||
    typeof base64 !== "string"
  ) {
    return "image/jpeg";
  }

  if (base64.startsWith("/9j/")) {
    return "image/jpeg";
  }

  if (
    base64.startsWith("iVBORw0KGgo")
  ) {
    return "image/png";
  }

  if (base64.startsWith("R0lGOD")) {
    return "image/gif";
  }

  if (base64.startsWith("UklGR")) {
    return "image/webp";
  }

  return "image/jpeg";
}

/**
 * Responses API 图片消息格式。
 */
function buildImageUserContent(
  text,
  imageBase64
) {
  const mimeType =
    detectImageMimeType(imageBase64);

  return [
    {
      type: "input_text",
      text
    },
    {
      type: "input_image",
      image_url:
        `data:${mimeType};base64,${imageBase64}`
    }
  ];
}

function detectLongTask(message) {
  const longTaskKeywords = [
    "写一篇",
    "作文",
    "文章",
    "故事",
    "报告",
    "演讲稿",
    "文案",
    "总结",
    "详细",
    "展开",
    "认真分析",
    "帮我分析",
    "深度分析",
    "完整分析",
    "全面分析",
    "长文",
    "3000字",
    "2000字",
    "1000字"
  ];

  return longTaskKeywords.some(
    (keyword) =>
      message.includes(keyword)
  );
}

function detectForceShort(message) {
  const forceShortKeywords = [
    "简洁点",
    "短一点",
    "说重点",
    "直接点",
    "不要超过",
    "只能说",
    "只说",
    "只回",
    "一句话",
    "别展开"
  ];

  return forceShortKeywords.some(
    (keyword) =>
      message.includes(keyword)
  );
}

function resolveMaxTokens({
  imageBase64,
  isLongTask,
  isForceShort
}) {
  if (isForceShort) {
    return 400;
  }

  if (imageBase64) {
    return 2200;
  }

  if (isLongTask) {
    return 3500;
  }

  return 2200;
}

/**
 * 把 Android 历史消息转成
 * Responses API 可接受的输入。
 */
function buildHistoryMessages(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-10)
    .map((item) => {
      const role =
        item.role === "user" ||
        item.isUser === true
          ? "user"
          : "assistant";

      const content =
        item.content ||
        item.text ||
        "";

      return {
        role,
        content:
          String(content).trim()
      };
    })
    .filter(
      (item) =>
        item.content.length > 0
    );
}

app.get("/", (req, res) => {
  res.send(
    "Maymate backend is running"
  );
});

/**
 * 健康检查接口。
 *
 * 可以用来确认：
 * 1. 默认模型档位
 * 2. CORE 模型
 * 3. PREMIUM 模型
 * 4. API 模式
 */
app.get("/health", (req, res) => {
  res.json({
    status: "online",

    message:
      "Maymate backend online",

    defaultModelTier:
      DEFAULT_MODEL_TIER,

    models: {
      core:
        MODEL_CONFIG[
          MODEL_TIER.CORE
        ],

      premium:
        MODEL_CONFIG[
          MODEL_TIER.PREMIUM
        ]
    },

    sttModel: STT_MODEL,

    apiMode: "responses"
  });
});

app.post("/chat", async (req, res) => {
  console.log(
    "🔥 收到手机聊天请求"
  );

  const {
    message,
    systemPrompt,
    imageBase64,
    history,
    mode,
    modelTier
  } = req.body;

  /**
   * 根据 Android 传入的 modelTier
   * 选择最终模型。
   *
   * Android 暂时不传时，
   * 会自动选择 core。
   */
  const selectedModel =
    resolveModel({
      modelTier,

      hasImage:
        Boolean(imageBase64)
    });

  console.log(
    "🧠 SYSTEM:",
    systemPrompt
  );

  console.log(
    "👤 USER:",
    message
  );

  console.log(
    "🖼️ HAS IMAGE:",
    Boolean(imageBase64)
  );

  console.log(
    "📚 HISTORY COUNT:",
    Array.isArray(history)
      ? history.length
      : 0
  );

  console.log(
    "🎚️ REQUESTED MODEL TIER:",
    modelTier || "not provided"
  );

  console.log(
    "🧠 SELECTED MODEL TIER:",
    selectedModel.tier
  );

  console.log(
    "🚀 SELECTED MODEL:",
    selectedModel.model
  );

  console.log(
    "🎚️ MODE:",
    mode || "default"
  );

  try {
    if (
      !process.env.OPENAI_API_KEY
    ) {
      throw new Error(
        "Missing OPENAI_API_KEY"
      );
    }

    const cleanMessage =
      typeof message === "string" &&
      message.trim()
        ? message.trim()
        : "请识别这张图片。如果图里有题目、英文、表格或作业内容，请先准确识别，再直接回答。";

    const isLongTask =
      detectLongTask(cleanMessage);

    const isForceShort =
      detectForceShort(cleanMessage);

    const maxTokens =
      resolveMaxTokens({
        imageBase64,
        isLongTask,
        isForceShort
      });

    let finalSystemPrompt = `
${systemPrompt || ""}

【后端最高优先级兜底规则】
1. Android 端传来的 systemPrompt 是主要规则，你必须优先遵守。
2. 用户要求完成任务时，必须直接完成，不要只讲方法。
3. 用户要求“写作文、写一篇、翻译、总结、改句子、写代码、列计划、起标题、写文案”时，直接输出成品。
4. 用户说“只能回我嗯”“接下来只说嗯”“只回某句话”这类临时规则时，必须照做，除非涉及危险、违法或明显不安全内容。
5. 用户只是打招呼、随口聊天或简单确认时，默认保持简洁。
6. 不要把普通抱怨自动扩展成人生分析、关系分析或系统性报告。
7. 用户要求“简洁点、短一点、说重点、直接点”时，必须压缩，只保留核心。
8. Android 端已经提供明确回复结构、分析深度和长度要求时，优先服从 Android 端 systemPrompt。
`.trim();

    if (imageBase64) {
      finalSystemPrompt =
        `${finalSystemPrompt}

【图片规则】
1. 用户发送图片时，必须先基于图片内容回答。
2. 如果图片中是数学题、作业题、英文题、表格或截图，先准确识别题目或关键信息，再回答。
3. 如果是数学题，直接给出答案，并提供清晰步骤。
4. 如果图片模糊或信息不完整，明确指出看不清的部分，不要乱猜。
`.trim();
    }

    const historyMessages =
      buildHistoryMessages(history);

    const currentUserMessage = {
      role: "user",

      content: imageBase64
        ? buildImageUserContent(
            cleanMessage,
            imageBase64
          )
        : cleanMessage
    };

    const input = [
      ...historyMessages,
      currentUserMessage
    ];

    console.log(
      "🧭 LONG TASK:",
      isLongTask
    );

    console.log(
      "✂️ FORCE SHORT:",
      isForceShort
    );

    console.log(
      "🎛️ MAX OUTPUT TOKENS:",
      maxTokens
    );

    /**
     * CORE 和 PREMIUM
     * 当前都统一使用 Responses API。
     *
     * 暂时不传：
     * reasoning
     * text.verbosity
     * temperature
     *
     * 避免模型参数不兼容。
     */
    const response =
      await openai.responses.create({
        model:
          selectedModel.model,

        instructions:
          finalSystemPrompt,

        input,

        max_output_tokens:
          maxTokens
      });

    const reply =
      response.output_text?.trim() ||
      "抱歉，我现在没组织好回答。";

    const responseStatus =
      response.status ||
      "unknown";

    const incompleteReason =
      response
        .incomplete_details
        ?.reason ||
      null;

    /**
     * usage 日志。
     *
     * 后面可以用这些数据
     * 精确计算不同模型成本。
     */
    const usage =
      response.usage || {};

    const inputTokens =
      usage.input_tokens || 0;

    const cachedInputTokens =
      usage
        .input_tokens_details
        ?.cached_tokens || 0;

    const outputTokens =
      usage.output_tokens || 0;

    const totalTokens =
      usage.total_tokens ||
      inputTokens + outputTokens;

    console.log(
      "✅ AI返回：",
      reply
    );

    console.log(
      "🏁 RESPONSE STATUS:",
      responseStatus
    );

    console.log(
      "⚠️ INCOMPLETE REASON:",
      incompleteReason || "none"
    );

    console.log(
      "📏 REPLY CHARS:",
      reply.length
    );

    console.log(
      "🎛️ USED MAX OUTPUT TOKENS:",
      maxTokens
    );

    console.log(
      "🤖 USED MODEL:",
      response.model ||
        selectedModel.model
    );

    console.log(
      "🧠 USED MODEL TIER:",
      selectedModel.tier
    );

    console.log(
      "💰 INPUT TOKENS:",
      inputTokens
    );

    console.log(
      "♻️ CACHED INPUT TOKENS:",
      cachedInputTokens
    );

    console.log(
      "💬 OUTPUT TOKENS:",
      outputTokens
    );

    console.log(
      "📊 TOTAL TOKENS:",
      totalTokens
    );

    return res.json({
      reply,

      finishReason:
        incompleteReason ||
        responseStatus,

      responseStatus,

      incompleteReason,

      replyLength:
        reply.length,

      maxTokens,

      model:
        response.model ||
        selectedModel.model,

      modelTier:
        selectedModel.tier,

      usage: {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens
      }
    });
  } catch (error) {
    console.log(
      "❌ 聊天接口报错:",
      error
    );

    return res
      .status(
        error?.status || 500
      )
      .json({
        reply:
          "服务器错误：" +
          (
            error?.message ||
            "未知错误"
          ),

        error:
          error?.message ||
          "未知错误",

        status:
          error?.status || 500,

        model:
          selectedModel.model,

        modelTier:
          selectedModel.tier
      });
  }
});

app.get(
  "/web-search",
  async (req, res) => {
    try {
      const query =
        req.query.q;

      if (
        !query ||
        String(query)
          .trim()
          .length === 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing query"
          });
      }

      if (
        !process.env
          .TAVILY_API_KEY
      ) {
        return res
          .status(500)
          .json({
            error:
              "Missing TAVILY_API_KEY in .env"
          });
      }

      const cleanQuery =
        String(query).trim();

      const tavilyResponse =
        await axios.post(
          "https://api.tavily.com/search",

          {
            query: cleanQuery,

            search_depth:
              "basic",

            max_results: 5,

            include_answer:
              true,

            include_raw_content:
              false
          },

          {
            headers: {
              "Content-Type":
                "application/json",

              Authorization:
                `Bearer ${process.env.TAVILY_API_KEY}`
            },

            timeout: 12000
          }
        );

      const rawResults =
        tavilyResponse
          .data
          ?.results || [];

      const results =
        rawResults.map(
          (item) => ({
            title:
              item.title ||
              "Untitled",

            snippet:
              item.content ||
              item.snippet ||
              "",

            url:
              item.url || ""
          })
        );

      return res.json({
        query: cleanQuery,

        answer:
          tavilyResponse
            .data
            ?.answer ||
          "",

        results
      });
    } catch (error) {
      console.error(
        "WEB_SEARCH_ERROR:",

        error.response
          ?.data ||
          error.message
      );

      return res
        .status(500)
        .json({
          error:
            "Search failed",

          detail:
            error.response
              ?.data ||
            error.message
        });
    }
  }
);

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on http://0.0.0.0:${PORT}`
    );

    console.log(
      "🧠 DEFAULT MODEL TIER:",
      DEFAULT_MODEL_TIER
    );

    console.log(
      "🤖 CORE MODEL:",
      MODEL_CONFIG[
        MODEL_TIER.CORE
      ].chat
    );

    console.log(
      "🚀 PREMIUM MODEL:",
      MODEL_CONFIG[
        MODEL_TIER.PREMIUM
      ].chat
    );
  }
);
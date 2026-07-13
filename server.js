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
    const extension = path.extname(file.originalname) || ".m4a";
    callback(null, `${Date.now()}${extension}`);
  }
});

const upload = multer({ storage });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const CHAT_MODEL = "gpt-4.1-mini";
const VISION_MODEL = "gpt-4.1-mini";
const STT_MODEL = "whisper-1";

async function toSimplifiedChinese(text) {
  if (!text) {
    return "";
  }

  if (!OpenCC) {
    return text;
  }

  try {
    const converter = new OpenCC("t2s.json");
    return await converter.convertPromise(text);
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
  if (!base64 || typeof base64 !== "string") {
    return "image/jpeg";
  }

  if (base64.startsWith("/9j/")) {
    return "image/jpeg";
  }

  if (base64.startsWith("iVBORw0KGgo")) {
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

function buildImageUserContent(text, imageBase64) {
  const mimeType = detectImageMimeType(imageBase64);

  return [
    {
      type: "text",
      text
    },
    {
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${imageBase64}`
      }
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

  return longTaskKeywords.some((keyword) =>
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

  return forceShortKeywords.some((keyword) =>
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

app.get("/", (req, res) => {
  res.send("Maymate backend is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    message: "Maymate backend online",
    chatModel: CHAT_MODEL,
    visionModel: VISION_MODEL,
    sttModel: STT_MODEL
  });
});

app.post("/chat", async (req, res) => {
  console.log("🔥 收到手机聊天请求");

  const {
    message,
    systemPrompt,
    imageBase64,
    history,
    mode
  } = req.body;

  console.log("🧠 SYSTEM:", systemPrompt);
  console.log("👤 USER:", message);
  console.log("🖼️ HAS IMAGE:", Boolean(imageBase64));
  console.log(
    "📚 HISTORY COUNT:",
    Array.isArray(history) ? history.length : 0
  );
  console.log("🚀 CURRENT CHAT MODEL:", CHAT_MODEL);
  console.log("🎚️ MODE:", mode || "default");

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    const cleanMessage =
      typeof message === "string" && message.trim()
        ? message.trim()
        : "请识别这张图片。如果图里有题目、英文、表格或作业内容，请先准确识别，再直接回答。";

    const isLongTask = detectLongTask(cleanMessage);
    const isForceShort = detectForceShort(cleanMessage);

    const maxTokens = resolveMaxTokens({
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
5. 用户只是打招呼、随口聊天或发出简单确认时，默认保持简洁。
6. 不要把普通抱怨自动扩展成人生分析、关系分析或系统性报告。
7. 如果用户要求“简洁点、短一点、说重点、直接点”，必须压缩，只保留核心。
8. 如果 Android 端已经提供了明确的回复结构、分析深度和长度要求，优先服从 Android 端 systemPrompt。
`.trim();

    if (imageBase64) {
      finalSystemPrompt = `${finalSystemPrompt}

【图片规则】
1. 用户发送图片时，必须先基于图片内容回答。
2. 如果图片中是数学题、作业题、英文题、表格或截图，先准确识别题目或关键信息，再回答。
3. 如果是数学题，直接给出答案，并提供清晰步骤。
4. 如果图片模糊或信息不完整，明确指出看不清的部分，不要乱猜。
`.trim();
    }

    const historyMessages = Array.isArray(history)
      ? history
          .slice(-10)
          .map((item) => {
            const role =
              item.role === "user" || item.isUser === true
                ? "user"
                : "assistant";

            const content =
              item.content ||
              item.text ||
              "";

            return {
              role,
              content: String(content).trim()
            };
          })
          .filter((item) => item.content.length > 0)
      : [];

    const userContent = imageBase64
      ? buildImageUserContent(
          cleanMessage,
          imageBase64
        )
      : cleanMessage;

    const messages = [
      {
        role: "system",
        content: finalSystemPrompt
      },
      ...historyMessages,
      {
        role: "user",
        content: userContent
      }
    ];

    console.log("🧭 LONG TASK:", isLongTask);
    console.log("✂️ FORCE SHORT:", isForceShort);
    console.log("🎛️ MAX TOKENS:", maxTokens);

    const completion =
      await openai.chat.completions.create({
        model: imageBase64
          ? VISION_MODEL
          : CHAT_MODEL,

        messages,

        max_tokens: maxTokens
      });

    const choice = completion.choices?.[0];

    const reply =
      choice?.message?.content?.trim() ||
      "抱歉，我现在没组织好回答。";

    const finishReason =
      choice?.finish_reason ||
      "unknown";

    console.log("✅ AI返回：", reply);
    console.log(
      "🏁 FINISH REASON:",
      finishReason
    );
    console.log(
      "📏 REPLY CHARS:",
      reply.length
    );
    console.log(
      "🎛️ USED MAX TOKENS:",
      maxTokens
    );
    console.log(
      "🤖 USED MODEL:",
      completion.model || CHAT_MODEL
    );

    return res.json({
      reply,
      finishReason,
      replyLength: reply.length,
      maxTokens,
      model: completion.model || CHAT_MODEL
    });
  } catch (error) {
    console.log(
      "❌ 聊天接口报错:",
      error
    );

    return res.status(500).json({
      reply:
        "服务器错误：" +
        (error?.message || "未知错误"),

      error:
        error?.message || "未知错误"
    });
  }
});

app.get("/web-search", async (req, res) => {
  try {
    const query = req.query.q;

    if (
      !query ||
      String(query).trim().length === 0
    ) {
      return res.status(400).json({
        error: "Missing query"
      });
    }

    if (!process.env.TAVILY_API_KEY) {
      return res.status(500).json({
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
          search_depth: "basic",
          max_results: 5,
          include_answer: true,
          include_raw_content: false
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
      tavilyResponse.data?.results || [];

    const results =
      rawResults.map((item) => ({
        title:
          item.title || "Untitled",

        snippet:
          item.content ||
          item.snippet ||
          "",

        url:
          item.url || ""
      }));

    return res.json({
      query: cleanQuery,
      answer:
        tavilyResponse.data?.answer ||
        "",
      results
    });
  } catch (error) {
    console.error(
      "WEB_SEARCH_ERROR:",
      error.response?.data ||
      error.message
    );

    return res.status(500).json({
      error: "Search failed",

      detail:
        error.response?.data ||
        error.message
    });
  }
});

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on http://0.0.0.0:${PORT}`
    );
  }
);
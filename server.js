const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ChatwMe_Bot_Secure_2024_XyZ789';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyA2GuLFnl2EM_cCwx_S_Xsx7eoB7mcuOhM';

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// In-memory conversation storage (for production, use a database)
const conversations = new Map();
const MAX_CONVERSATION_LENGTH = 20; // Keep last 20 messages

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const upload = multer({ 
    dest: 'temp/',
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Helper function to detect language
function detectLanguage(text) {
    const arabicRegex = /[\u0600-\u06FF]/;
    const frenchRegex = /[àâäéèêëïîôöùûüÿç]/i;
    
    if (arabicRegex.test(text)) {
        return 'arabic';
    } else if (frenchRegex.test(text)) {
        return 'french';
    }
    return 'english';
}

// Helper function to get conversation context
function getConversationContext(userId) {
    if (!conversations.has(userId)) {
        conversations.set(userId, []);
    }
    return conversations.get(userId);
}

// Helper function to add message to conversation
function addToConversation(userId, role, message) {
    const conversation = getConversationContext(userId);
    conversation.push({ role, message, timestamp: new Date() });
    
    // Keep only last MAX_CONVERSATION_LENGTH messages
    if (conversation.length > MAX_CONVERSATION_LENGTH) {
        conversation.shift();
    }
    
    conversations.set(userId, conversation);
}

// Helper function to format conversation for AI
function formatConversationForAI(conversation) {
    if (conversation.length === 0) return '';
    
    const context = conversation.map(msg => 
        `${msg.role}: ${msg.message}`
    ).join('\n');
    
    return `Previous conversation:\n${context}\n\nCurrent message:`;
}

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Webhook verification attempt:', { mode, token, challenge });

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            console.log('Webhook verification failed - wrong token');
            res.sendStatus(403);
        }
    } else {
        console.log('Webhook verification failed - missing parameters');
        res.sendStatus(400);
    }
});

// Webhook message handling endpoint
app.post('/webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(function(entry) {
            const webhookEvent = entry.messaging[0];
            console.log('Received webhook event:', JSON.stringify(webhookEvent, null, 2));

            const senderId = webhookEvent.sender.id;

            if (webhookEvent.message) {
                handleMessage(senderId, webhookEvent.message);
            } else if (webhookEvent.postback) {
                handlePostback(senderId, webhookEvent.postback);
            }
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

app.get('/privacy', (req, res) => {
    res.sendFile(__dirname + '/privacy.html');
});


// Handle incoming messages
async function handleMessage(senderId, message) {
    console.log(`Processing message from ${senderId}:`, message);

    // Send typing indicator
    await sendTypingIndicator(senderId, 'typing_on');

    try {
        if (message.text) {
            // Handle text messages
            await handleTextMessage(senderId, message.text);
        } else if (message.attachments) {
            // Handle attachments (images, audio, etc.)
            await handleAttachments(senderId, message.attachments);
        }
    } catch (error) {
        console.error('Error handling message:', error);
        const errorMessage = detectLanguage(message.text || '') === 'arabic' 
            ? 'عذراً، واجهت خطأ في معالجة رسالتك. يرجى المحاولة مرة أخرى.'
            : 'Sorry, I encountered an error processing your message. Please try again.';
        await sendTextMessage(senderId, errorMessage);
    } finally {
        // Turn off typing indicator
        await sendTypingIndicator(senderId, 'typing_off');
    }
}

// Handle text messages with Gemini and conversation memory
async function handleTextMessage(senderId, text) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        // Get conversation context
        const conversation = getConversationContext(senderId);
        const conversationContext = formatConversationForAI(conversation);
        
        // Detect language
        const language = detectLanguage(text);
        
        // Create language-aware prompt
        let languageInstruction = '';
        if (language === 'arabic') {
            languageInstruction = 'You must respond in Arabic or Algerian Darija. Be natural and conversational in Arabic. Understand both Modern Standard Arabic and Algerian Darija (Algerian Arabic dialect).';
        } else if (language === 'french') {
            languageInstruction = 'You must respond in French. Be natural and conversational in French.';
        } else {
            languageInstruction = 'Respond in English, but if the user switches to Arabic or French, match their language.';
        }
        
        const prompt = `You are ChatwMe, a helpful and friendly AI assistant chatbot on Facebook Messenger. You are conversational, engaging, and remember previous messages in the conversation.

IMPORTANT LANGUAGE RULES:
${languageInstruction}

PERSONALITY:
- Be warm, friendly, and helpful
- Show personality and humor when appropriate
- Remember what users tell you in the conversation
- Be culturally aware for Moroccan/Algerian users
- Keep responses concise but engaging (under 400 characters when possible)
- Use emojis sparingly but effectively

CONVERSATION CONTEXT:
${conversationContext}

User's message: "${text}"

Remember to maintain the conversation flow and reference previous messages when relevant.`;

        const result = await model.generateContent(prompt);
        const response = result.response;
        const aiResponse = response.text();

        // Add messages to conversation memory
        addToConversation(senderId, 'user', text);
        addToConversation(senderId, 'assistant', aiResponse);

        await sendTextMessage(senderId, aiResponse);
    } catch (error) {
        console.error('Error with Gemini text generation:', error);
        const language = detectLanguage(text);
        const errorMessage = language === 'arabic' 
            ? 'عذراً، لم أتمكن من فهم ذلك. هل يمكنك إعادة صياغة رسالتك؟'
            : 'Sorry, I had trouble understanding that. Could you try rephrasing?';
        await sendTextMessage(senderId, errorMessage);
    }
}

// Handle attachments (images, audio, etc.)
async function handleAttachments(senderId, attachments) {
    for (const attachment of attachments) {
        console.log('Processing attachment:', attachment.type);

        switch (attachment.type) {
            case 'image':
                await handleImageAttachment(senderId, attachment);
                break;
            case 'audio':
                await handleAudioAttachment(senderId, attachment);
                break;
            case 'video':
                await sendTextMessage(senderId, 'I can see you sent a video! 🎬 While I can\'t process videos yet, I\'d love to help you with images or text messages. 😊');
                break;
            case 'file':
                await sendTextMessage(senderId, 'Thanks for sending a file! 📄 I work best with images and text messages right now.');
                break;
            default:
                await sendTextMessage(senderId, 'I received your message! I work best with text messages and images. How can I help you today? 😊');
        }
    }
}

// Handle image attachments with Gemini Vision and conversation memory
async function handleImageAttachment(senderId, attachment) {
    try {
        console.log('Processing image attachment:', attachment.payload.url);
        
        // Get conversation context to determine user's preferred language
        const conversation = getConversationContext(senderId);
        const lastUserMessage = conversation.filter(msg => msg.role === 'user').pop();
        const userLanguage = lastUserMessage ? detectLanguage(lastUserMessage.message) : 'english';
        
        // Download the image
        const imageResponse = await axios.get(attachment.payload.url, {
            responseType: 'arraybuffer',
            headers: {
                'Authorization': `Bearer ${PAGE_ACCESS_TOKEN}`
            }
        });

        // Convert to base64
        const imageBuffer = Buffer.from(imageResponse.data);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';

        // Use Gemini Vision to analyze the image
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        let prompt = '';
        if (userLanguage === 'arabic') {
            prompt = "صف ما تراه في هذه الصورة بطريقة ودية ومحادثة. اجعل الوصف موجزاً وجذاباً، كما لو كنت تتحدث مع صديق.";
        } else {
            prompt = "Describe what you see in this image in a friendly, conversational way. Keep it concise and engaging, as if you're chatting with a friend on messenger.";
        }

        const imagePart = {
            inlineData: {
                data: base64Image,
                mimeType: mimeType
            }
        };

        const result = await model.generateContent([prompt, imagePart]);
        const response = result.response;
        const description = response.text();

        const responseMessage = userLanguage === 'arabic' 
            ? `يمكنني رؤية صورتك! 📸 ${description}`
            : `I can see your image! 📸 ${description}`;

        // Add to conversation memory
        addToConversation(senderId, 'user', '[Image sent]');
        addToConversation(senderId, 'assistant', responseMessage);

        await sendTextMessage(senderId, responseMessage);

    } catch (error) {
        console.error('Error processing image:', error);
        await sendTextMessage(senderId, 'I can see you sent an image, but I had trouble analyzing it. Could you try again or describe what you\'d like to know about it? 🤔');
    }
}

// Handle audio attachments (voice messages) - Enhanced with speech-to-text simulation
async function handleAudioAttachment(senderId, attachment) {
    try {
        console.log('Processing audio attachment:', attachment.payload.url);
        
        // Get user's preferred language from conversation
        const conversation = getConversationContext(senderId);
        const lastUserMessage = conversation.filter(msg => msg.role === 'user').pop();
        const userLanguage = lastUserMessage ? detectLanguage(lastUserMessage.message) : 'english';
        
        // For now, we'll acknowledge the voice message and ask for text
        // TODO: Implement actual speech-to-text using Google Speech-to-Text API
        let responseMessage = '';
        if (userLanguage === 'arabic') {
            responseMessage = 'استلمت رسالتك الصوتية! 🎵 حالياً لا أستطيع معالجة الرسائل الصوتية، لكن يمكنك كتابة رسالتك وسأكون سعيداً لمساعدتك!';
        } else {
            responseMessage = 'I received your voice message! 🎵 While I can\'t process audio yet, feel free to type your message and I\'ll be happy to help!';
        }
        
        // Add to conversation memory
        addToConversation(senderId, 'user', '[Voice message sent]');
        addToConversation(senderId, 'assistant', responseMessage);
        
        await sendTextMessage(senderId, responseMessage);
        
        // TODO: Implement actual speech-to-text conversion
        // You could integrate with Google Speech-to-Text API, OpenAI Whisper, or similar
        
    } catch (error) {
        console.error('Error processing audio:', error);
        await sendTextMessage(senderId, 'I had trouble with your voice message. Could you try typing your message instead? 🤔');
    }
}

// Handle postback events (button clicks, etc.)
async function handlePostback(senderId, postback) {
    console.log('Handling postback:', postback);
    
    const payload = postback.payload;
    
    switch (payload) {
        case 'GET_STARTED':
            const welcomeMessage = '👋 مرحباً! أنا ChatwMe، مساعدك الذكي المدعوم بالذكاء الاصطناعي.\n\nHi! I\'m ChatwMe, your AI assistant. I can help you with questions, analyze images, and have conversations in Arabic, French, or English. What would you like to talk about?';
            
            // Add to conversation memory
            addToConversation(senderId, 'assistant', welcomeMessage);
            
            await sendTextMessage(senderId, welcomeMessage);
            break;
        default:
            await sendTextMessage(senderId, 'Thanks for that! How can I help you today? 😊');
    }
}

// Send text message to user
async function sendTextMessage(recipientId, messageText) {
    if (!PAGE_ACCESS_TOKEN) {
        console.error('PAGE_ACCESS_TOKEN is not set');
        return;
    }

    const messageData = {
        recipient: { id: recipientId },
        message: { text: messageText }
    };

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            messageData,
            { headers: { 'Content-Type': 'application/json' } }
        );
        
        console.log('Message sent successfully:', response.data);
    } catch (error) {
        console.error('Error sending message:', error.response?.data || error.message);
    }
}

// Send typing indicator
async function sendTypingIndicator(recipientId, action) {
    if (!PAGE_ACCESS_TOKEN) return;

    const messageData = {
        recipient: { id: recipientId },
        sender_action: action
    };

    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            messageData,
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Error sending typing indicator:', error.response?.data || error.message);
    }
}

// Clean up old conversations (run every hour)
setInterval(() => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    for (const [userId, conversation] of conversations.entries()) {
        // Remove conversations with no activity in the last hour
        const lastMessage = conversation[conversation.length - 1];
        if (lastMessage && lastMessage.timestamp < oneHourAgo) {
            conversations.delete(userId);
            console.log(`Cleaned up conversation for user ${userId}`);
        }
    }
}, 60 * 60 * 1000); // Run every hour

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ChatwMe Bot is running! 🚀',
        timestamp: new Date().toISOString(),
        features: [
            '💬 Multi-language support (Arabic, French, English)',
            '🧠 Conversation memory',
            '📸 Image analysis',
            '🎵 Voice message acknowledgment',
            '🌍 Cultural awareness'
        ],
        endpoints: {
            webhook_verify: 'GET /webhook',
            webhook_receive: 'POST /webhook'
        },
        conversations_active: conversations.size
    });
});

// Create temp directory if it doesn't exist
if (!fs.existsSync('temp')) {
    fs.mkdirSync('temp');
}

// Start server
app.listen(PORT, () => {
    console.log(`🚀 ChatwMe Bot server is running on port ${PORT}`);
    console.log(`📝 Webhook URL will be: https://your-deployment-url.com/webhook`);
    console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
    console.log(`📱 Make sure to set your PAGE_ACCESS_TOKEN environment variable`);
    console.log(`🌍 Multi-language support: Arabic, French, English`);
    console.log(`🧠 Conversation memory: ${MAX_CONVERSATION_LENGTH} messages per user`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});
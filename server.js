const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 8080; // Changed from 3000 to 8080 to match Railway

// Configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ChatwMe_Bot_Secure_2024_XyZ789';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCC4i0gPwEV2zHZxsoa4G8JL1KK1_4w6Q0';

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Rate limiting for API calls
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute per user

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

// Rate limiting function
function isRateLimited(userId) {
    const now = Date.now();
    const userRequests = rateLimiter.get(userId) || [];
    
    // Remove old requests outside the window
    const validRequests = userRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    
    if (validRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
        return true;
    }
    
    // Add current request
    validRequests.push(now);
    rateLimiter.set(userId, validRequests);
    return false;
}

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

// Helper function to check if user is asking about developer
function isDeveloperQuestion(text) {
    const lowerText = text.toLowerCase();
    
    // English variations
    const englishPatterns = [
        'who created you', 'who made you', 'who developed you', 'who is your developer',
        'who built you', 'your creator', 'your developer', 'who programmed you',
        'who designed you', 'your maker', 'who owns you'
    ];
    
    // Arabic variations
    const arabicPatterns = [
        'من صنعك', 'من طورك', 'من صممك', 'من المطور', 'من الصانع',
        'من خلقك', 'من برمجك', 'مين عملك', 'مين صنعك', 'مطورك مين'
    ];
    
    // French variations
    const frenchPatterns = [
        'qui t\'a créé', 'qui t\'a développé', 'qui t\'a fait', 'ton développeur',
        'qui est ton créateur', 'ton créateur', 'qui t\'a programmé'
    ];
    
    const allPatterns = [...englishPatterns, ...arabicPatterns, ...frenchPatterns];
    
    return allPatterns.some(pattern => lowerText.includes(pattern));
}

// Helper function to get developer response
function getDeveloperResponse(language) {
    switch (language) {
        case 'arabic':
            return 'مطوري هو عبدو 👨‍💻 شخص موهوب جداً وذكي! هو من صنعني وعلمني كيف أساعد الناس. أنا فخور بأن أكون من إبداعاته! 🚀';
        case 'french':
            return 'Mon développeur est Abdou 👨‍💻 Il est très talentueux et intelligent ! C\'est lui qui m\'a créé et m\'a appris à aider les gens. Je suis fier d\'être une de ses créations ! 🚀';
        default:
            return 'My developer is Abdou 👨‍💻 He\'s incredibly talented and smart! He created me and taught me how to help people. I\'m proud to be one of his creations! 🚀';
    }
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

// Helper function to get error message by language
function getErrorMessage(language, errorType = 'general') {
    const messages = {
        arabic: {
            general: 'عذراً، واجهت خطأ في معالجة رسالتك. يرجى المحاولة مرة أخرى. 🤖',
            rateLimit: 'عذراً، أنت ترسل رسائل كثيرة جداً. يرجى الانتظار قليلاً قبل المحاولة مرة أخرى. ⏰',
            understanding: 'عذراً، لم أتمكن من فهم ذلك. هل يمكنك إعادة صياغة رسالتك؟ 🤔',
            apiError: 'أواجه مشكلة تقنية حالياً. يرجى المحاولة مرة أخرى خلال بضع ثوانٍ. ⚡'
        },
        french: {
            general: 'Désolé, j\'ai rencontré une erreur en traitant votre message. Veuillez réessayer. 🤖',
            rateLimit: 'Désolé, vous envoyez trop de messages. Veuillez attendre un peu avant de réessayer. ⏰',
            understanding: 'Désolé, je n\'ai pas pu comprendre cela. Pourriez-vous reformuler votre message ? 🤔',
            apiError: 'Je rencontre un problème technique actuellement. Veuillez réessayer dans quelques secondes. ⚡'
        },
        english: {
            general: 'Sorry, I encountered an error processing your message. Please try again. 🤖',
            rateLimit: 'Sorry, you\'re sending too many messages. Please wait a moment before trying again. ⏰',
            understanding: 'Sorry, I had trouble understanding that. Could you try rephrasing? 🤔',
            apiError: 'I\'m experiencing a technical issue right now. Please try again in a few seconds. ⚡'
        }
    };
    
    return messages[language]?.[errorType] || messages.english[errorType];
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.send('Bot is running');
});

// Privacy policy endpoint
app.get('/privacy', (req, res) => {
    res.sendFile(__dirname + '/privacy.html');
});

// Handle incoming messages
async function handleMessage(senderId, message) {
    console.log(`Processing message from ${senderId}:`, message);

    // Check rate limiting
    if (isRateLimited(senderId)) {
        const language = detectLanguage(message.text || '');
        const rateLimitMessage = getErrorMessage(language, 'rateLimit');
        await sendTextMessage(senderId, rateLimitMessage);
        return;
    }

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
        const language = detectLanguage(message.text || '');
        const errorMessage = getErrorMessage(language, 'general');
        await sendTextMessage(senderId, errorMessage);
    } finally {
        // Turn off typing indicator
        await sendTypingIndicator(senderId, 'typing_off');
    }
}

// Handle text messages with Gemini 2.0 Flash and enhanced error handling
async function handleTextMessage(senderId, text) {
    const language = detectLanguage(text);
    
    try {
        // Check if user is asking about developer
        if (isDeveloperQuestion(text)) {
            const developerResponse = getDeveloperResponse(language);
            addToConversation(senderId, 'user', text);
            addToConversation(senderId, 'assistant', developerResponse);
            await sendTextMessage(senderId, developerResponse);
            return;
        }

        // Use Gemini 2.0 Flash (latest model)
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash-exp",
            generationConfig: {
                temperature: 0.7,
                topP: 0.8,
                topK: 40,
                maxOutputTokens: 1000,
            }
        });
        
        // Get conversation context
        const conversation = getConversationContext(senderId);
        const conversationContext = formatConversationForAI(conversation);
        
        // Create language-aware prompt
        let languageInstruction = '';
        if (language === 'arabic') {
            languageInstruction = 'You must respond in Arabic or Algerian Darija. Be natural and conversational in Arabic. Understand both Modern Standard Arabic and Algerian Darija (Algerian Arabic dialect).';
        } else if (language === 'french') {
            languageInstruction = 'You must respond in French. Be natural and conversational in French.';
        } else {
            languageInstruction = 'Respond in English, but if the user switches to Arabic or French, match their language.';
        }
        
        const prompt = `You are ChatwMe, a helpful and friendly AI assistant chatbot on Facebook Messenger created by Abdou. You are conversational, engaging, and remember previous messages in the conversation.

IMPORTANT LANGUAGE RULES:
${languageInstruction}

PERSONALITY:
- Be warm, friendly, and helpful
- Show personality and humor when appropriate
- Remember what users tell you in the conversation
- Be culturally aware for Moroccan/Algerian users
- Keep responses concise but engaging (under 400 characters when possible)
- Use emojis sparingly but effectively
- If asked about your developer/creator, always mention that Abdou created you

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
        
        let errorMessage;
        if (error.message.includes('429') || error.message.includes('quota')) {
            errorMessage = getErrorMessage(language, 'apiError');
            console.log('Rate limit hit, waiting before retry...');
            // Wait 30 seconds before allowing next request for this user
            setTimeout(() => {
                rateLimiter.delete(senderId);
            }, 30000);
        } else if (error.message.includes('400') || error.message.includes('invalid')) {
            errorMessage = getErrorMessage(language, 'understanding');
        } else {
            errorMessage = getErrorMessage(language, 'general');
        }
        
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

// Handle image attachments with Gemini 2.0 Flash Vision and enhanced error handling
async function handleImageAttachment(senderId, attachment) {
    const conversation = getConversationContext(senderId);
    const lastUserMessage = conversation.filter(msg => msg.role === 'user').pop();
    const userLanguage = lastUserMessage ? detectLanguage(lastUserMessage.message) : 'english';
    
    try {
        console.log('Processing image attachment:', attachment.payload.url);
        
        // Download the image with retry logic
        let imageResponse;
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                imageResponse = await axios.get(attachment.payload.url, {
                    responseType: 'arraybuffer',
                    timeout: 10000,
                    headers: {
                        'Authorization': `Bearer ${PAGE_ACCESS_TOKEN}`,
                        'User-Agent': 'ChatwMe-Bot/2.0'
                    }
                });
                break;
            } catch (downloadError) {
                attempts++;
                if (attempts >= maxAttempts) throw downloadError;
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
            }
        }

        // Convert to base64
        const imageBuffer = Buffer.from(imageResponse.data);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';

        // Use Gemini 2.0 Flash for image analysis
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash-exp",
            generationConfig: {
                temperature: 0.7,
                topP: 0.8,
                maxOutputTokens: 500,
            }
        });
        
        let prompt = '';
        if (userLanguage === 'arabic') {
            prompt = "صف ما تراه في هذه الصورة بطريقة ودية ومحادثة. اجعل الوصف موجزاً وجذاباً، كما لو كنت تتحدث مع صديق. لا تجعل الوصف طويلاً جداً.";
        } else if (userLanguage === 'french') {
            prompt = "Décris ce que tu vois dans cette image de manière amicale et conversationnelle. Garde la description concise et engageante, comme si tu parlais à un ami. Ne fais pas la description trop longue.";
        } else {
            prompt = "Describe what you see in this image in a friendly, conversational way. Keep it concise and engaging, as if you're chatting with a friend on messenger. Don't make the description too long.";
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

        let responseMessage;
        if (userLanguage === 'arabic') {
            responseMessage = `يمكنني رؤية صورتك! 📸 ${description}`;
        } else if (userLanguage === 'french') {
            responseMessage = `Je peux voir votre image ! 📸 ${description}`;
        } else {
            responseMessage = `I can see your image! 📸 ${description}`;
        }

        // Add to conversation memory
        addToConversation(senderId, 'user', '[Image sent]');
        addToConversation(senderId, 'assistant', responseMessage);

        await sendTextMessage(senderId, responseMessage);

    } catch (error) {
        console.error('Error processing image:', error);
        
        let errorMessage;
        if (userLanguage === 'arabic') {
            errorMessage = 'يمكنني رؤية أنك أرسلت صورة، لكن واجهت مشكلة في تحليلها. هل يمكنك المحاولة مرة أخرى أو وصف ما تريد معرفته عنها؟ 🤔';
        } else if (userLanguage === 'french') {
            errorMessage = 'Je peux voir que vous avez envoyé une image, mais j\'ai eu des difficultés à l\'analyser. Pourriez-vous réessayer ou décrire ce que vous aimeriez savoir à ce sujet ? 🤔';
        } else {
            errorMessage = 'I can see you sent an image, but I had trouble analyzing it. Could you try again or describe what you\'d like to know about it? 🤔';
        }
        
        await sendTextMessage(senderId, errorMessage);
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
        let responseMessage = '';
        if (userLanguage === 'arabic') {
            responseMessage = 'استلمت رسالتك الصوتية! 🎵 حالياً لا أستطيع معالجة الرسائل الصوتية، لكن يمكنك كتابة رسالتك وسأكون سعيداً لمساعدتك!';
        } else if (userLanguage === 'french') {
            responseMessage = 'J\'ai reçu votre message vocal ! 🎵 Actuellement, je ne peux pas traiter les messages audio, mais vous pouvez taper votre message et je serai heureux de vous aider !';
        } else {
            responseMessage = 'I received your voice message! 🎵 While I can\'t process audio yet, feel free to type your message and I\'ll be happy to help!';
        }
        
        // Add to conversation memory
        addToConversation(senderId, 'user', '[Voice message sent]');
        addToConversation(senderId, 'assistant', responseMessage);
        
        await sendTextMessage(senderId, responseMessage);
        
    } catch (error) {
        console.error('Error processing audio:', error);
        const conversation = getConversationContext(senderId);
        const lastUserMessage = conversation.filter(msg => msg.role === 'user').pop();
        const userLanguage = lastUserMessage ? detectLanguage(lastUserMessage.message) : 'english';
        
        const errorMessage = getErrorMessage(userLanguage, 'general');
        await sendTextMessage(senderId, errorMessage);
    }
}

// Handle postback events (button clicks, etc.)
async function handlePostback(senderId, postback) {
    console.log('Handling postback:', postback);
    
    const payload = postback.payload;
    
    switch (payload) {
        case 'GET_STARTED':
            const welcomeMessage = '👋 مرحباً! أنا ChatwMe، مساعدك الذكي المدعوم بالذكاء الاصطناعي من تطوير عبدو.\n\nHi! I\'m ChatwMe, your AI assistant created by Abdou. I can help you with questions, analyze images, and have conversations in Arabic, French, or English. What would you like to talk about?';
            
            // Add to conversation memory
            addToConversation(senderId, 'assistant', welcomeMessage);
            
            await sendTextMessage(senderId, welcomeMessage);
            break;
        default:
            await sendTextMessage(senderId, 'Thanks for that! How can I help you today? 😊');
    }
}

// Send text message to user with enhanced error handling
async function sendTextMessage(recipientId, messageText) {
    if (!PAGE_ACCESS_TOKEN) {
        console.error('PAGE_ACCESS_TOKEN is not set');
        return;
    }

    const messageData = {
        recipient: { id: recipientId },
        message: { text: messageText }
    };

    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
        try {
            const response = await axios.post(
                `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
                messageData,
                { 
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000
                }
            );
            
            console.log('Message sent successfully:', {
                recipient_id: recipientId,
                message_id: response.data.message_id
            });
            return;
            
        } catch (error) {
            attempts++;
            console.error(`Error sending message (attempt ${attempts}):`, error.response?.data || error.message);
            
            if (attempts >= maxAttempts) {
                console.error('Failed to send message after maximum attempts');
                return;
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
    }
}

// Send typing indicator with error handling
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
            { 
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            }
        );
    } catch (error) {
        console.error('Error sending typing indicator:', error.response?.data || error.message);
    }
}

// Clean up old conversations and rate limiter (run every hour)
cron.schedule('0 * * * *', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    // Clean conversations
    for (const [userId, conversation] of conversations.entries()) {
        const lastMessage = conversation[conversation.length - 1];
        if (lastMessage && lastMessage.timestamp < oneHourAgo) {
            conversations.delete(userId);
            console.log(`Cleaned up conversation for user ${userId}`);
        }
    }
    
    // Clean rate limiter
    rateLimiter.clear();
    console.log('Rate limiter cleaned');
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ChatwMe Bot v2.0 is running! 🚀',
        timestamp: new Date().toISOString(),
        model: 'Gemini 2.0 Flash',
        developer: 'Abdou',
        features: [
            '💬 Multi-language support (Arabic, French, English)',
            '🧠 Conversation memory with context',
            '📸 Advanced image analysis with Gemini 2.0 Flash',
            '🎵 Voice message acknowledgment',
            '🌍 Cultural awareness for MENA region',
            '⚡ Enhanced error handling and retry logic',
            '🔒 Rate limiting protection',
            '🕐 Automatic cleanup system'
        ],
        endpoints: {
            webhook_verify: 'GET /webhook',
            webhook_receive: 'POST /webhook',
            privacy: 'GET /privacy'
        },
        stats: {
            conversations_active: conversations.size,
            rate_limited_users: rateLimiter.size
        }
    });
});

// Create temp directory if it doesn't exist
if (!fs.existsSync('temp')) {
    fs.mkdirSync('temp');
}

// Start server - SINGLE LISTEN CALL
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ChatwMe Bot v2.0 server is running on port ${PORT}`);
    console.log(`🤖 Powered by Gemini 2.0 Flash`);
    console.log(`👨‍💻 Developed by Abdou`);
    console.log(`📝 Webhook URL: https://your-deployment-url.com/webhook`);
    console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
    console.log(`📱 Make sure to set your PAGE_ACCESS_TOKEN environment variable`);
    console.log(`🌍 Multi-language support: Arabic, French, English`);
    console.log(`🧠 Conversation memory: ${MAX_CONVERSATION_LENGTH} messages per user`);
    console.log(`⚡ Enhanced error handling and rate limiting enabled`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});
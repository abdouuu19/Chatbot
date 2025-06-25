require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const moment = require('moment');
const cron = require('node-cron');

const app = express();

// FIX: Configure trust proxy securely for Railway
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Logging setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ChatwMe_Bot_Secure_2024_XyZ789';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// User conversation memory
const conversationMemory = new Map();
const userProfiles = new Map();

// Language detection
class LanguageDetector {
    static patterns = {
        arabic: {
            regex: /[\u0600-\u06FF]/,
            keywords: ['السلام', 'مرحبا', 'شكرا', 'نعم', 'لا', 'كيف', 'ماذا', 'أين', 'متى', 'لماذا'],
            weight: 3
        },
        darija: {
            regex: /\b(كيفاش|واش|بزاف|مزيان|شنو|فين|دابا|راك|راه|كيراك|وش راك)\b/i,
            keywords: ['كيفاش', 'واش', 'بزاف', 'مزيان', 'شنو', 'فين', 'دابا', 'راك', 'راه'],
            weight: 4
        },
        french: {
            regex: /\b(bonjour|salut|merci|comment|ça|va|oui|non|avec|dans|pour|très|bien)\b/i,
            keywords: ['bonjour', 'salut', 'merci', 'comment', 'ça va', 'oui', 'non'],
            weight: 2
        },
        english: {
            regex: /\b(hello|hi|thank|thanks|how|what|where|when|why|good|great)\b/i,
            keywords: ['hello', 'hi', 'thank', 'thanks', 'how', 'what', 'good', 'great'],
            weight: 1
        }
    };

    static detect(text) {
        const scores = {};
        
        for (const [lang, config] of Object.entries(this.patterns)) {
            scores[lang] = 0;
            
            if (config.regex.test(text)) {
                scores[lang] += config.weight * 2;
            }
            
            const lowerText = text.toLowerCase();
            const matchedKeywords = config.keywords.filter(keyword => 
                lowerText.includes(keyword.toLowerCase())
            );
            scores[lang] += matchedKeywords.length * config.weight;
        }
        
        const detectedLang = Object.keys(scores).reduce((a, b) => 
            scores[a] > scores[b] ? a : b
        );
        
        return scores[detectedLang] > 0 ? detectedLang : 'english';
    }
}

// Homepage route
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Privacy Policy route
app.get('/privacy', (req, res) => {
    res.sendFile(__dirname + '/privacy.html');
});

// Enhanced creator detection - more comprehensive patterns
const isAskingAboutCreator = (text) => {
    const creatorPatterns = [
        // English variations
        /who\s+(created|made|built|developed|designed|programmed)\s+you/i,
        /your\s+(creator|maker|developer|designer|programmer|author|owner)/i,
        /who\s+(is\s+)?your\s+(dad|father|boss|owner|parent)/i,
        /who\s+(are\s+)?you/i,
        /tell\s+me\s+about\s+(yourself|your\s+creator)/i,
        /what\s+(is\s+)?your\s+name/i,
        /introduce\s+yourself/i,
        
        // Arabic variations
        /من\s+(صنعك|خلقك|صممك|برمجك|عملك|طورك)/i,
        /مين\s+(صنعك|عملك|خلقك|صممك)/i,
        /(منشئك|صانعك|مطورك|خالقك)/i,
        /من\s+انت/i,
        /ما\s+اسمك/i,
        /عرفني\s+(عليك|على\s+نفسك)/i,
        /اسمك\s+ايه/i,
        
        // French variations
        /qui\s+t['']?a\s+(créé|fait|développé|conçu|programmé)/i,
        /ton\s+(créateur|développeur|concepteur|programmeur)/i,
        /qui\s+es\s+tu/i,
        /quel\s+est\s+ton\s+nom/i,
        /comment\s+tu\s+t['']?appelles/i,
        /présente\s+toi/i,
        
        // Darija variations
        /شكون\s+(صنعك|عملك|خلقك|صممك)/i,
        /مين\s+(صنعك|عملك|خلقك)/i,
        /شكون\s+نت/i,
        /شنو\s+سميتك/i,
        /عرفني\s+(عليك|على\s+راسك)/i,
        /واش\s+سميتك/i,
        /إيه\s+اسمك/i
    ];
    
    return creatorPatterns.some(pattern => pattern.test(text));
};

// Creator responses with proper identification
const getCreatorResponse = (language) => {
    const responses = {
        english: {
            text: "🤖✨ I'm ChatWme, an AI assistant proudly created by Abdou! He's an amazing developer who built me to be helpful and smart. I can speak multiple languages including English, Arabic, French, and Algerian Darija! 🚀\n\nWant to meet my awesome creator? Click below! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 Meet Abdou - My Creator!"
            }]
        },
        arabic: {
            text: "🤖✨ أنا ChatWme، مساعد ذكي من إبداع المطور الرائع عبدو! هو مطور مذهل صنعني لأكون مفيد وذكي. أستطيع التحدث بعدة لغات منها الإنجليزية والعربية والفرنسية والدارجة الجزائرية! 🚀\n\nتريد أن تتعرف على منشئي الرائع؟ اضغط أدناه! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 تعرف على عبدو - منشئي!"
            }]
        },
        french: {
            text: "🤖✨ Je suis ChatWme, un assistant IA fièrement créé par Abdou! C'est un développeur incroyable qui m'a conçu pour être utile et intelligent. Je peux parler plusieurs langues dont l'anglais, l'arabe, le français et le darija algérien! 🚀\n\nVous voulez rencontrer mon créateur génial? Cliquez ci-dessous! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 Rencontrer Abdou - Mon Créateur!"
            }]
        },
        darija: {
            text: "🤖✨ أنا ChatWme، مساعد ذكي من صنع المطور الرائع عبدو! راه مطور مذهل صنعني باش نكون مفيد وذكي. نقدر نهدر بعدة لغات منها الإنجليزية والعربية والفرنسية والدارجة الجزائرية! 🚀\n\nتحب تتعرف على اللي صنعني؟ دوس تحت! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 تعرف على عبدو - اللي صنعني!"
            }]
        }
    };
    
    return responses[language] || responses.english;
};

// Media (image/voice/video) responses - text-based AI message
const getMediaResponse = (language, mediaType = 'media') => {
    const responses = {
        english: `I'm a text-based AI assistant and can't process ${mediaType === 'image' ? 'images' : mediaType === 'audio' ? 'voice messages' : 'media files'}. Please send me a text message and I'll be happy to help you! 📝✨`,
        
        arabic: `أنا مساعد ذكي نصي ولا أستطيع معالجة ${mediaType === 'image' ? 'الصور' : mediaType === 'audio' ? 'الرسائل الصوتية' : 'ملفات الوسائط'}. يرجى إرسال رسالة نصية وسأكون سعيداً لمساعدتك! 📝✨`,
        
        french: `Je suis un assistant IA textuel et je ne peux pas traiter ${mediaType === 'image' ? 'les images' : mediaType === 'audio' ? 'les messages vocaux' : 'les fichiers multimédias'}. Veuillez m'envoyer un message texte et je serai ravi de vous aider! 📝✨`,
        
        darija: `أنا مساعد ذكي نصي وما نقدرش نعالج ${mediaType === 'image' ? 'الصور' : mediaType === 'audio' ? 'الرسائل الصوتية' : 'ملفات الوسائط'}. عطني رسالة نصية ونكون فرحان نعاونك! 📝✨`
    };
    
    return responses[language] || responses.english;
};

// Simplified Groq API integration
const callGroqAPI = async (messages, language) => {
    const models = {
        arabic: 'allam-2-7b',
        english: 'llama-3.3-70b-versatile',
        fallback: 'llama-3.1-8b-instant'
    };
    
    const detectLanguage = (messages) => {
        const arabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
        const lastUserMessage = messages.filter(msg => msg.role === 'user').pop();
        
        if (!lastUserMessage) return 'english';
        return arabicRegex.test(lastUserMessage.content) ? 'arabic' : 'english';
    };
    
    const detectedLang = detectLanguage(messages);
    const selectedModel = detectedLang === 'arabic' ? models.arabic : models.english;
    
    // Updated system prompt that emphasizes creator identity
    const systemPrompt = detectedLang === 'arabic' ? 
        'أنت ChatWme، مساعد ذكي صنعه عبدو. أجب بذكاء ووضوح في جملة أو جملتين قصيرتين. لا تذكر أي فريق أو شركة، أنت من صنع عبدو فقط.' :
        'You are ChatWme, an AI assistant created by Abdou. Answer intelligently and clearly in 1-2 short sentences. Never mention any team or company, you are created by Abdou only.';
    
    const finalMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.filter(msg => msg.role !== 'system')
    ];
    
    const config = selectedModel === models.arabic ? {
        max_tokens: 200,
        temperature: 0.4,
        top_p: 0.7
    } : {
        max_tokens: 250,
        temperature: 0.5,
        top_p: 0.8
    };
    
    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: selectedModel,
            messages: finalMessages,
            max_tokens: config.max_tokens,
            temperature: config.temperature,
            top_p: config.top_p,
            frequency_penalty: 0.3,
            presence_penalty: 0.3,
            stream: false
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data.choices[0].message.content.trim();
    } catch (error) {
        logger.error('Groq API Error:', error.response?.data || error.message);
        
        if (selectedModel !== models.fallback) {
            try {
                const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                    model: models.fallback,
                    messages: finalMessages,
                    max_tokens: 180,
                    temperature: 0.4,
                    top_p: 0.7,
                    frequency_penalty: 0.3,
                    presence_penalty: 0.3,
                    stream: false
                }, {
                    headers: {
                        'Authorization': `Bearer ${GROQ_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000
                });
                return response.data.choices[0].message.content.trim();
            } catch (fallbackError) {
                logger.error('Fallback also failed:', fallbackError.response?.data || fallbackError.message);
            }
        }
        
        return detectedLang === 'arabic' ? 
            "خطأ تقني، جرب مرة أخرى. 🤖" : 
            "Technical error, try again. 🤖";
    }
};

// Enhanced message sending
const sendMessage = async (senderId, messageText, buttons = null) => {
    try {
        let messageData = {
            recipient: { id: senderId },
            message: {}
        };

        if (buttons && buttons.length > 0) {
            messageData.message = {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "button",
                        text: messageText.substring(0, 640),
                        buttons: buttons.slice(0, 3)
                    }
                }
            };
        } else {
            if (messageText.length > 2000) {
                const chunks = messageText.match(/.{1,1900}(\s|$)/g) || [messageText];
                for (let i = 0; i < chunks.length && i < 3; i++) {
                    await sendMessage(senderId, chunks[i].trim());
                    if (i < chunks.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                return;
            }
            messageData.message.text = messageText;
        }

        const response = await axios.post(`https://graph.facebook.com/v18.0/me/messages`, messageData, {
            params: { access_token: PAGE_ACCESS_TOKEN }
        });
        
        logger.info(`Message sent to ${senderId}`);
        return response.data;
    } catch (error) {
        logger.error('Error sending message:', error.response?.data || error.message);
        throw error;
    }
};

// Typing indicator
const sendTypingIndicator = async (senderId, action = 'typing_on') => {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
            recipient: { id: senderId },
            sender_action: action
        }, {
            params: { access_token: PAGE_ACCESS_TOKEN }
        });
    } catch (error) {
        logger.error('Error sending typing indicator:', error.response?.data || error.message);
    }
};

// Get user profile
const getUserProfile = async (senderId) => {
    try {
        const response = await axios.get(`https://graph.facebook.com/v18.0/${senderId}`, {
            params: {
                fields: 'first_name,last_name,profile_pic,locale',
                access_token: PAGE_ACCESS_TOKEN
            }
        });
        
        return response.data;
    } catch (error) {
        logger.error('Error getting user profile:', error.response?.data || error.message);
        return null;
    }
};

// Main message processing function
const processMessage = async (senderId, messageText, attachments = null) => {
    try {
        await sendTypingIndicator(senderId, 'typing_on');
        
        // Get or create user profile
        let userProfile = userProfiles.get(senderId);
        if (!userProfile) {
            const fbProfile = await getUserProfile(senderId);
            userProfile = {
                id: senderId,
                firstName: fbProfile?.first_name || 'Friend',
                conversationStarted: new Date(),
                messageCount: 0
            };
            userProfiles.set(senderId, userProfile);
        }
        
        userProfile.messageCount++;
        userProfile.lastMessageTime = new Date();
        
        // Detect language first
        const detectedLanguage = LanguageDetector.detect(messageText || '');
        logger.info(`Detected language: ${detectedLanguage} for user ${senderId}`);
        
        // Handle media attachments FIRST - before any AI processing
        if (attachments && attachments.length > 0) {
            let mediaType = 'media';
            
            for (const attachment of attachments) {
                if (attachment.type === 'image') {
                    mediaType = 'image';
                    break;
                } else if (attachment.type === 'audio') {
                    mediaType = 'audio';
                    break;
                } else if (attachment.type === 'video') {
                    mediaType = 'video';
                    break;
                }
            }
            
            const mediaResponse = getMediaResponse(detectedLanguage, mediaType);
            await sendTypingIndicator(senderId, 'typing_off');
            await sendMessage(senderId, mediaResponse);
            return;
        }
        
        // If no text message, return
        if (!messageText || messageText.trim() === '') {
            await sendTypingIndicator(senderId, 'typing_off');
            return;
        }
        
        // Check if asking about creator BEFORE AI processing
        if (isAskingAboutCreator(messageText)) {
            const creatorResponse = getCreatorResponse(detectedLanguage);
            await sendTypingIndicator(senderId, 'typing_off');
            await sendMessage(senderId, creatorResponse.text, creatorResponse.buttons);
            return;
        }
        
        // Add realistic thinking delay
        const thinkingDelay = Math.min(Math.max(messageText.length * 50, 1000), 4000);
        await new Promise(resolve => setTimeout(resolve, thinkingDelay));
        
        // Get conversation history
        let conversation = conversationMemory.get(senderId) || [];
        
        // Add user message to conversation
        conversation.push({ role: 'user', content: messageText });
        
        // Keep conversation history manageable
        if (conversation.length > 20) {
            conversation = conversation.slice(-20);
        }
        
        // Get AI response
        const aiResponse = await callGroqAPI(conversation, detectedLanguage);
        
        // Add AI response to conversation history
        conversation.push({ role: 'assistant', content: aiResponse });
        conversationMemory.set(senderId, conversation);
        
        // Send response
        await sendTypingIndicator(senderId, 'typing_off');
        await sendMessage(senderId, aiResponse);
        
        logger.info(`Successful interaction with user ${senderId} (${detectedLanguage})`);
        
    } catch (error) {
        logger.error('Error processing message:', error);
        await sendTypingIndicator(senderId, 'typing_off');
        
        const errorResponses = {
            english: "I apologize for the technical difficulty! 🤖 Let me try to help you again.",
            arabic: "أعتذر عن المشكلة التقنية! 🤖 دعني أحاول مساعدتك مرة أخرى.",
            french: "Je m'excuse pour le problème technique! 🤖 Laissez-moi essayer de vous aider à nouveau.",
            darija: "سمح ليا على المشكل التقني! 🤖 خلني نحاول نعاونك مرة خرى."
        };
        
        const language = LanguageDetector.detect(messageText || '');
        await sendMessage(senderId, errorResponses[language] || errorResponses.english);
    }
};

// Webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        logger.info('Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        logger.error('Webhook verification failed');
        res.status(403).send('Forbidden');
    }
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        
        if (body.object === 'page') {
            for (const entry of body.entry) {
                for (const webhookEvent of entry.messaging) {
                    const senderId = webhookEvent.sender.id;
                    
                    if (webhookEvent.sender.id === entry.id) {
                        continue;
                    }
                    
                    if (webhookEvent.message) {
                        const messageText = webhookEvent.message.text;
                        const attachments = webhookEvent.message.attachments;
                        
                        setImmediate(() => {
                            processMessage(senderId, messageText || '', attachments);
                        });
                    }
                    else if (webhookEvent.postback) {
                        const payload = webhookEvent.postback.payload;
                        const title = webhookEvent.postback.title;
                        
                        setImmediate(() => {
                            processMessage(senderId, `${title}: ${payload}`);
                        });
                    }
                }
            }
            
            res.status(200).send('EVENT_RECEIVED');
        } else {
            res.status(404).send('Not Found');
        }
    } catch (error) {
        logger.error('Webhook processing error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeUsers: conversationMemory.size
    });
});

// Clean up old conversations
cron.schedule('0 * * * *', () => {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let cleanedCount = 0;
    
    for (const [userId, profile] of userProfiles.entries()) {
        if (profile.lastMessageTime && profile.lastMessageTime < cutoffTime) {
            conversationMemory.delete(userId);
            cleanedCount++;
        }
    }
    
    logger.info(`Cleaned up ${cleanedCount} old conversations`);
});

// Error handling middleware
app.use((error, req, res, next) => {
    logger.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    logger.info(`🚀 ChatWme Bot Server is running on port ${PORT}`);
    logger.info(`✅ Webhook URL: ${process.env.WEBHOOK_URL || `http://localhost:${PORT}`}/webhook`);
    logger.info(`🤖 Bot created by Abdou is ready to chat!`);
    console.log(`
    ╔═══════════════════════════════════════╗
    ║          ChatWme Bot Server           ║
    ║              by Abdou                 ║
    ║                                       ║
    ║  🚀 Server running on port ${PORT}       ║
    ║  🤖 Groq AI Integration Active        ║
    ║  🌍 Multi-language Support Ready     ║
    ║  ✅ Ready to serve users!             ║
    ╚═══════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    process.exit(0);
});
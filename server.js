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

// Enhanced Language detection with smarter patterns
class LanguageDetector {
    static patterns = {
        arabic: {
            // Arabic script detection
            script: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
            // Common Arabic/Darija words and phrases
            keywords: [
                'كيف', 'شنو', 'واش', 'فين', 'كيفاش', 'دابا', 'بزاف', 'مزيان', 'راك', 'راه',
                'السلام', 'مرحبا', 'شكرا', 'نعم', 'لا', 'ماذا', 'أين', 'متى', 'لماذا',
                'شكون', 'أشنو', 'فوقاش', 'علاش', 'كيراك', 'لاباس', 'بخير', 'الحمد'
            ],
            weight: 3
        },
        french: {
            // French specific patterns
            keywords: [
                'bonjour', 'salut', 'merci', 'comment', 'ça', 'va', 'oui', 'non', 'avec', 'dans',
                'pour', 'très', 'bien', 'bonsoir', 'bonne', 'jour', 'merci', 'beaucoup',
                'pardon', 'excusez', 'moi', 'vous', 'êtes', 'suis', 'votre', 'notre'
            ],
            weight: 2
        },
        english: {
            // English patterns
            keywords: [
                'hello', 'hi', 'thank', 'thanks', 'how', 'what', 'where', 'when', 'why',
                'good', 'great', 'please', 'you', 'your', 'the', 'and', 'that', 'this'
            ],
            weight: 1
        }
    };

    static detect(text) {
        if (!text || text.trim() === '') return 'english';
        
        const scores = { arabic: 0, french: 0, english: 0 };
        const lowerText = text.toLowerCase();
        
        // Check for Arabic script (highest priority)
        if (this.patterns.arabic.script.test(text)) {
            scores.arabic += 10; // Heavy weight for Arabic script
        }
        
        // Check for language-specific keywords
        for (const [lang, config] of Object.entries(this.patterns)) {
            if (config.keywords) {
                const matches = config.keywords.filter(keyword => 
                    lowerText.includes(keyword.toLowerCase())
                ).length;
                scores[lang] += matches * config.weight;
            }
        }
        
        // Determine the language with highest score
        const detectedLang = Object.keys(scores).reduce((a, b) => 
            scores[a] > scores[b] ? a : b
        );
        
        // Return detected language if score > 0, otherwise default to English
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

// Smart creator detection - simplified and more efficient
const isAskingAboutCreator = (text) => {
    const lowerText = text.toLowerCase();
    
    // English patterns
    const englishPatterns = [
        'who created you', 'who made you', 'your creator', 'who built you',
        'who are you', 'your maker', 'who developed you', 'your developer'
    ];
    
    // Arabic patterns (including Darija)
    const arabicPatterns = [
        'من صنعك', 'مين صنعك', 'من خلقك', 'شكون صنعك', 'من عملك', 'مين عملك',
        'من انت', 'شكون نت', 'منشئك', 'صانعك', 'مطورك'
    ];
    
    // French patterns
    const frenchPatterns = [
        'qui t\'a créé', 'qui es tu', 'ton créateur', 'qui t\'a fait',
        'ton développeur', 'qui t\'a développé'
    ];
    
    const allPatterns = [...englishPatterns, ...arabicPatterns, ...frenchPatterns];
    
    return allPatterns.some(pattern => lowerText.includes(pattern));
};

// Smart profile/Facebook link detection
const isAskingAboutProfile = (text) => {
    const lowerText = text.toLowerCase();
    
    const profilePatterns = [
        // English
        'your profile', 'facebook profile', 'your facebook', 'profile link',
        'facebook link', 'your page', 'creator profile', 'abdou profile','abdou link',
        
        // Arabic
        'ملفك', 'صفحتك', 'فيسبوك', 'رابط', 'ملف عبدو', 'صفحة عبدو',
        'بروفايل', 'الملف الشخصي', 'حسابك',
        
        // French
        'ton profil', 'profil facebook', 'ton facebook', 'lien profil',
        'ta page', 'profil abdou'
    ];
    
    return profilePatterns.some(pattern => lowerText.includes(pattern));
};

// Creator responses
const getCreatorResponse = (language) => {
    const responses = {
        english: {
            text: "🤖 I'm ChatwMe, an AI assistant created by Abdou. I can communicate in multiple languages.\n\n👨‍💻 Meet my creator: https://facebook.com/abdou.tsu.446062"
        },
        arabic: {
            text: "🤖 أنا ChatwMe، مساعد ذكي من إبداع عبدو. يمكنني التواصل بلغات متعددة.\n\n👨‍💻 تعرف على منشئي: https://facebook.com/abdou.tsu.446062"
        },
        french: {
            text: "🤖 Je suis ChatwMe, un assistant IA créé par Abdou. Je peux communiquer en plusieurs langues.\n\n👨‍💻 Rencontrer mon créateur: https://facebook.com/abdou.tsu.446062"
        }
    };
    
    return responses[language] || responses.english;
};

// Profile link responses
const getProfileResponse = (language) => {
    const responses = {
        english: {
            text: "📱 Here's Abdou's Facebook profile - my creator and developer.\n\n👨‍💻 https://facebook.com/abdou.tsu.446062"
        },
        arabic: {
            text: "📱 هذا ملف عبدو الشخصي على فيسبوك - منشئي والمطور.\n\n👨‍💻 https://facebook.com/abdou.tsu.446062"
        },
        french: {
            text: "📱 Voici le profil Facebook d'Abdou - mon créateur et développeur.\n\n👨‍💻 https://facebook.com/abdou.tsu.446062"
        }
    };
    
    return responses[language] || responses.english;
};


// Media responses
const getMediaResponse = (language, mediaType = 'media') => {
    const responses = {
        english: `I'm a text-based AI assistant and can't process ${mediaType === 'image' ? 'images' : mediaType === 'audio' ? 'voice messages' : 'media files'}. Please send me a text message and I'll be happy to help you! 📝✨`,
        
        arabic: `أنا مساعد ذكي نصي ولا أستطيع معالجة ${mediaType === 'image' ? 'الصور' : mediaType === 'audio' ? 'الرسائل الصوتية' : 'ملفات الوسائط'}. يرجى إرسال رسالة نصية وسأكون سعيداً لمساعدتك! 📝✨`,
        
        french: `Je suis un assistant IA textuel et je ne peux pas traiter ${mediaType === 'image' ? 'les images' : mediaType === 'audio' ? 'les messages vocaux' : 'les fichiers multimédias'}. Veuillez m'envoyer un message texte et je serai ravi de vous aider! 📝✨`
    };
    
    return responses[language] || responses.english;
};

// First-time welcome message
const getWelcomeMessage = (userName, language) => {
    const greetings = {
        english: {
            text: `Hello ${userName}! I'm ChatwMe, your AI assistant. How can I help you today?\n\n👨‍💻 Meet my creator: https://facebook.com/abdou.tsu.446062`
        },
        arabic: {
            text: `مرحباً ${userName}! أنا ChatwMe، مساعدك الذكي. كيف يمكنني مساعدتك اليوم؟\n\n👨‍💻 تعرف على منشئي: https://facebook.com/abdou.tsu.446062`
        },
        french: {
            text: `Bonjour ${userName}! Je suis ChatwMe, votre assistant IA. Comment puis-je vous aider aujourd'hui?\n\n👨‍💻 Rencontrer mon créateur: https://facebook.com/abdou.tsu.446062`
        }
    };
    
    return greetings[language] || greetings.english;
};
// Enhanced user profile fetching
const getEnhancedUserProfile = async (senderId) => {
    try {
        const response = await axios.get(`https://graph.facebook.com/v18.0/${senderId}`, {
            params: {
                fields: 'first_name,last_name,profile_pic',
                access_token: PAGE_ACCESS_TOKEN
            }
        });

        console.log('Successfully retrieved user profile:', response.data);
       
        return {
            firstName: response.data.first_name || 'Friend',
            lastName: response.data.last_name || '',
            fullName: response.data.first_name ? 
                `${response.data.first_name} ${response.data.last_name || ''}`.trim() : 
                'Friend',
            profilePic: response.data.profile_pic || null,
            locale: 'en_US',
            timezone: null
        };
    } catch (error) {
        console.error('Error getting user profile:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            senderId: senderId
        });
        
        return {
            firstName: 'Friend',
            lastName: '',
            fullName: 'Friend',
            profilePic: null,
            locale: 'en_US',
            timezone: null
        };
    }
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
    
    const systemPrompt = detectedLang === 'arabic' ? 
        'أنت ChatwMe، مساعد ذكي صنعه عبدو. أجب بذكاء ووضوح بالعربية الفصحى في جملة أو جملتين قصيرتين. لا تذكر أي فريق أو شركة، أنت من صنع عبدو فقط. لا تذكر من صنعك إلا إذا سُئلت مباشرة عن هويتك أو منشئك، لا تستخدم الدارجة أبداً.' :
        'You are ChatwMe, an AI assistant created by Abdou. Answer intelligently and clearly. Never mention any team or company, you are created by Abdou only. Only mention your creator when directly asked about your identity or who made you.';
    
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

// Enhanced message sending with better button handling
const sendMessage = async (senderId, messageText, buttons = null) => {
    try {
        let messageData = {
            recipient: { id: senderId },
            message: {}
        };

        if (buttons && buttons.length > 0) {
            const truncatedText = messageText.length > 640 ? messageText.substring(0, 637) + '...' : messageText;
            
            messageData.message = {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "button",
                        text: truncatedText,
                        buttons: buttons.slice(0, 3).map(button => ({
                            type: button.type,
                            url: button.url,
                            title: button.title.length > 20 ? button.title.substring(0, 17) + '...' : button.title
                        }))
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
            params: { access_token: PAGE_ACCESS_TOKEN },
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        logger.info(`Message sent to ${senderId}`, { hasButtons: !!buttons });
        return response.data;
    } catch (error) {
        logger.error('Error sending message:', {
            error: error.response?.data || error.message,
            messageLength: messageText?.length,
            hasButtons: !!buttons
        });
        throw error;
    }
};

// Typing indicator and seen status
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

// Mark message as seen
const markMessageAsSeen = async (senderId) => {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
            recipient: { id: senderId },
            sender_action: 'mark_seen'
        }, {
            params: { access_token: PAGE_ACCESS_TOKEN }
        });
        logger.info(`Message marked as seen for user ${senderId}`);
    } catch (error) {
        logger.error('Error marking message as seen:', error.response?.data || error.message);
    }
};

// Main message processing function
const processMessage = async (senderId, messageText, attachments = null) => {
    try {
        // Mark message as seen IMMEDIATELY
        await markMessageAsSeen(senderId);
        
        // Start typing indicator
        await sendTypingIndicator(senderId, 'typing_on');
        
        // Get or create user profile
        let userProfile = userProfiles.get(senderId);
        let isFirstTime = false;
        
        if (!userProfile) {
            const fbProfile = await getEnhancedUserProfile(senderId);
            userProfile = {
                id: senderId,
                firstName: fbProfile.firstName,
                fullName: fbProfile.fullName,
                profilePic: fbProfile.profilePic,
                locale: fbProfile.locale,
                conversationStarted: new Date(),
                messageCount: 0,
                isWelcomed: false // Track if user has been welcomed
            };
            userProfiles.set(senderId, userProfile);
            isFirstTime = true;
        }
        
        userProfile.messageCount++;
        userProfile.lastMessageTime = new Date();
        
        // Detect language
        const detectedLanguage = LanguageDetector.detect(messageText || '');
        logger.info(`Detected language: ${detectedLanguage} for user ${senderId}`);
        
        // Handle media attachments FIRST
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
        
        // Send welcome message ONLY for first-time users
        if (isFirstTime && !userProfile.isWelcomed) {
            userProfile.isWelcomed = true;
            const welcome = getWelcomeMessage(userProfile.firstName, detectedLanguage);
            await sendTypingIndicator(senderId, 'typing_off');
            await sendMessage(senderId, welcome.text, welcome.buttons);
            return;
        }
        
        // Check if asking about creator
        if (isAskingAboutCreator(messageText)) {
            const creatorResponse = getCreatorResponse(detectedLanguage);
            await sendTypingIndicator(senderId, 'typing_off');
            await sendMessage(senderId, creatorResponse.text, creatorResponse.buttons);
            return;
        }
        
        // Check if asking about profile/Facebook link
        if (isAskingAboutProfile(messageText)) {
            const profileResponse = getProfileResponse(detectedLanguage);
            await sendTypingIndicator(senderId, 'typing_off');
            await sendMessage(senderId, profileResponse.text, profileResponse.buttons);
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
            french: "Je m'excuse pour le problème technique! 🤖 Laissez-moi essayer de vous aider à nouveau."
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
    logger.info(`🚀 ChatwMe Bot Server is running on port ${PORT}`);
    logger.info(`✅ Webhook URL: ${process.env.WEBHOOK_URL || `http://localhost:${PORT}`}/webhook`);
    logger.info(`🤖 Bot created by Abdou is ready to chat!`);
    console.log(`
    ╔═══════════════════════════════════════╗
    ║         ChatwMe Bot Server           ║
    ║              by Abdou                 ║
    ║                                       ║
    ║  🚀 Server running on port ${PORT}       ║
    ║  🤖 Groq AI Integration Active        ║
    ║  🌍 Multi-language Support Ready     ║
    ║  ✅ Ready to serve users!             ║
    ╚═══════════════════════════════════════╝
    `);
})

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    process.exit(0);
});

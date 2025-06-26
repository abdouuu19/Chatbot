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

// Enhanced User conversation memory with persistence
const conversationMemory = new Map();
const userProfiles = new Map();

// User session management - FIXED
class UserSessionManager {
    static getUser(senderId) {
        return userProfiles.get(senderId);
    }
    
    static createOrUpdateUser(senderId, fbProfile) {
        const existingUser = userProfiles.get(senderId);
        const now = new Date();
        
        if (existingUser) {
            // Update existing user - DON'T reset welcome status
            existingUser.lastMessageTime = now;
            existingUser.messageCount++;
            existingUser.firstName = fbProfile.firstName; // Update in case name changed
            existingUser.fullName = fbProfile.fullName;
            return { user: existingUser, isNewUser: false };
        } else {
            // Create new user
            const newUser = {
                id: senderId,
                firstName: fbProfile.firstName,
                fullName: fbProfile.fullName,
                profilePic: fbProfile.profilePic,
                locale: fbProfile.locale,
                conversationStarted: now,
                lastMessageTime: now,
                messageCount: 1,
                isWelcomed: false,
                preferredLanguage: 'english'
            };
            userProfiles.set(senderId, newUser);
            return { user: newUser, isNewUser: true };
        }
    }
    
    static shouldShowWelcome(user) {
        return !user.isWelcomed;
    }
    
    static markWelcomed(userId) {
        const user = userProfiles.get(userId);
        if (user) {
            user.isWelcomed = true;
        }
    }
    
    static isReturningUser(user) {
        const hoursSinceLastMessage = user.lastMessageTime ? 
            (Date.now() - user.lastMessageTime.getTime()) / (1000 * 60 * 60) : 999;
        return user.messageCount > 1 && hoursSinceLastMessage < 72; // 3 days
    }
}

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

    static detect(text, userProfile = null) {
        if (!text || text.trim() === '') {
            return userProfile?.preferredLanguage || 'english';
        }
        
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
        
        // Update user's preferred language if we detected something
        if (userProfile && scores[detectedLang] > 0) {
            userProfile.preferredLanguage = detectedLang;
        }
        
        // Return detected language if score > 0, otherwise use user preference or default
        return scores[detectedLang] > 0 ? detectedLang : 
               (userProfile?.preferredLanguage || 'english');
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
        'من انت', 'شكون نت', 'منشئك', 'صانعك', 'مطورك','من أنت',
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

// Creator responses - SHORTENED
const getCreatorResponse = (language) => {
    const responses = {
        english: {
            text: "🤖 I'm ChatwMe, created by Abdou.\n👨‍💻 https://facebook.com/abdou.tsu.446062"
        },
        arabic: {
            text: "🤖 أنا ChatwMe، من إبداع عبدو.\n👨‍💻 https://facebook.com/abdou.tsu.446062"
        },
        french: {
            text: "🤖 Je suis ChatwMe, créé par Abdou.\n👨‍💻 https://facebook.com/abdou.tsu.446062"
        }
    };
    
    return responses[language] || responses.english;
};

// Profile link responses - SHORTENED
const getProfileResponse = (language) => {
    const responses = {
        english: {
            text: "👨‍💻 Abdou's Facebook:\nhttps://facebook.com/abdou.tsu.446062"
        },
        arabic: {
            text: "👨‍💻 فيسبوك عبدو:\nhttps://facebook.com/abdou.tsu.446062"
        },
        french: {
            text: "👨‍💻 Facebook d'Abdou:\nhttps://facebook.com/abdou.tsu.446062"
        }
    };
    
    return responses[language] || responses.english;
};

// Media responses - SHORTENED
const getMediaResponse = (language, mediaType = 'media') => {
    const responses = {
        english: `I only process text messages. Please send text instead! 📝`,
        arabic: `أعالج الرسائل النصية فقط. أرسل نصاً من فضلك! 📝`,
        french: `Je traite uniquement les messages texte. Envoyez du texte svp! 📝`
    };
    
    return responses[language] || responses.english;
};

// Welcome message - SHORTENED and SMARTER
const getWelcomeMessage = (userName, language) => {
    const greetings = {
        english: {
            text: `Hello ${userName}! I'm ChatwMe 🤖\nHow can I help you?`
        },
        arabic: {
            text: `مرحباً ${userName}! أنا ChatwMe 🤖\nكيف يمكنني مساعدتك؟`
        },
        french: {
            text: `Bonjour ${userName}! Je suis ChatwMe 🤖\nComment puis-je vous aider?`
        }
    };
    
    return greetings[language] || greetings.english;
};

// Returning user greeting - NEW
const getReturningUserGreeting = (userName, language) => {
    const greetings = {
        english: [`Welcome back, ${userName}! 👋`, `Hi again, ${userName}! 😊`, `Good to see you, ${userName}! ✨`],
        arabic: [`أهلاً بعودتك ${userName}! 👋`, `مرحباً مجدداً ${userName}! 😊`, `سعيد برؤيتك ${userName}! ✨`],
        french: [`Bon retour, ${userName}! 👋`, `Salut encore, ${userName}! 😊`, `Ravi de vous revoir, ${userName}! ✨`]
    };
    
    const options = greetings[language] || greetings.english;
    return options[Math.floor(Math.random() * options.length)];
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

// IMPROVED Groq API integration with shorter, smarter responses
const callGroqAPI = async (messages, language, userProfile) => {
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
    
    // IMPROVED system prompts for shorter, professional responses
    const systemPrompt = detectedLang === 'arabic' ? 
        `أنت ChatwMe، مساعد ذكي محترف صنعه عبدو. أجب بذكاء ووضوح واختصار. لا تتجاوز جملتين. كن مهنياً ومفيداً. لا تذكر منشئك إلا إذا سُئلت مباشرة. استخدم العربية الفصحى فقط.` :
        `You are ChatwMe, a professional AI assistant created by Abdou. Give smart, clear, concise answers. Maximum 2 sentences. Be professional and helpful. Only mention your creator when directly asked. Be conversational but professional.`;
    
    const finalMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.filter(msg => msg.role !== 'system')
    ];
    
    // REDUCED token limits for shorter responses
    const config = selectedModel === models.arabic ? {
        max_tokens: 120, // Reduced from 200
        temperature: 0.3, // Lower for more focused responses
        top_p: 0.6
    } : {
        max_tokens: 150, // Reduced from 250
        temperature: 0.4, // Lower for more focused responses
        top_p: 0.7
    };
    
    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: selectedModel,
            messages: finalMessages,
            max_tokens: config.max_tokens,
            temperature: config.temperature,
            top_p: config.top_p,
            frequency_penalty: 0.4, // Increased to avoid repetition
            presence_penalty: 0.4, // Increased for variety
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
                    max_tokens: 100, // Even shorter for fallback
                    temperature: 0.3,
                    top_p: 0.6,
                    frequency_penalty: 0.4,
                    presence_penalty: 0.4,
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
            // REDUCED message chunking limit
            if (messageText.length > 1000) { // Reduced from 2000
                const chunks = messageText.match(/.{1,950}(\s|$)/g) || [messageText]; // Reduced chunk size
                for (let i = 0; i < chunks.length && i < 2; i++) { // Max 2 chunks instead of 3
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

// IMPROVED Main message processing function
const processMessage = async (senderId, messageText, attachments = null) => {
    try {
        // Mark message as seen IMMEDIATELY
        await markMessageAsSeen(senderId);
        
        // Start typing indicator
        await sendTypingIndicator(senderId, 'typing_on');
        
        // Get or create user profile - FIXED SESSION MANAGEMENT
        const fbProfile = await getEnhancedUserProfile(senderId);
        const { user: userProfile, isNewUser } = UserSessionManager.createOrUpdateUser(senderId, fbProfile);
        
        // Detect language with user preference
        const detectedLanguage = LanguageDetector.detect(messageText || '', userProfile);
        logger.info(`Detected language: ${detectedLanguage} for user ${senderId} (new: ${isNewUser})`);
        
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
        
        // IMPROVED Welcome logic - only for truly new users
        if (isNewUser && UserSessionManager.shouldShowWelcome(userProfile)) {
            UserSessionManager.markWelcomed(senderId);
            const welcome = getWelcomeMessage(userProfile.firstName, detectedLanguage);
            await sendTypingIndicator(senderId, 'typing_off');
            await sendMessage(senderId, welcome.text, welcome.buttons);
            return;
        }
        
        // Smart returning user greeting (optional, for users coming back after long time)
        if (!isNewUser && UserSessionManager.isReturningUser(userProfile) && userProfile.messageCount === 1) {
            const greeting = getReturningUserGreeting(userProfile.firstName, detectedLanguage);
            await sendMessage(senderId, greeting);
            // Continue to process their actual message below
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
        
        // REDUCED thinking delay for faster responses
        const thinkingDelay = Math.min(Math.max(messageText.length * 30, 800), 2500); // Faster
        await new Promise(resolve => setTimeout(resolve, thinkingDelay));
        
        // Get conversation history - EXTENDED TO 300 MESSAGES
        let conversation = conversationMemory.get(senderId) || [];
        
        // Add user message to conversation
        conversation.push({ role: 'user', content: messageText });
        
        // Keep conversation history manageable - INCREASED TO 300
        if (conversation.length > 300) {
            // Keep the first 50 and last 250 for context preservation
            const keepStart = conversation.slice(0, 50);
            const keepEnd = conversation.slice(-250);
            conversation = [...keepStart, ...keepEnd];
        }
        
        // Get AI response
        const aiResponse = await callGroqAPI(conversation, detectedLanguage, userProfile);
        
        // Add AI response to conversation history
        conversation.push({ role: 'assistant', content: aiResponse });
        conversationMemory.set(senderId, conversation);
        
        // Send response
        await sendTypingIndicator(senderId, 'typing_off');
        await sendMessage(senderId, aiResponse);
        
        logger.info(`Successful interaction with user ${senderId} (${detectedLanguage}), Messages: ${conversation.length}`);
        
    } catch (error) {
        logger.error('Error processing message:', error);
        await sendTypingIndicator(senderId, 'typing_off');
        
        const errorResponses = {
            english: "Technical issue. Try again! 🤖",
            arabic: "مشكلة تقنية. جرب مرة أخرى! 🤖",
            french: "Problème technique. Réessayez! 🤖"
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
        activeUsers: conversationMemory.size,
        totalUsers: userProfiles.size
    });
});

// IMPROVED cleanup - preserve user sessions longer
cron.schedule('0 */6 * * *', () => { // Every 6 hours instead of hourly
    const cutoffTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days instead of 1 day
    let cleanedConversations = 0;
    
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

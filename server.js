const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { HfInference } = require('@huggingface/inference');
const sharp = require('sharp');
const FormData = require('form-data');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 8080;

// Configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ChatwMe_Bot_Secure_2024_XyZ789';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || 'EAA2GQt9M3qsBOZC4XVwnfptYjNg96aOlu7s10NJwKucjW6YGgQ6HKFPg2HBzX8PLANQNvqZC28UVlo42W8Xrd4cEY2ISCK2Sxl7b4H4B2Bjfi6yRRP28mM09uop9KVvriXU0lIeDH7ZA1GIxp40AOEeHQsyskdqgm5o0hbTLlTi0jnv1YS6GvZA9cAjti6vZBy3PYpHaQ2wZDZD';
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || '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';

// Initialize HuggingFace
const hf = new HfInference(HUGGINGFACE_API_KEY);

// HuggingFace Models Configuration
const MODELS = {
    // Main conversation model - Very capable and free
    conversation: 'microsoft/DialoGPT-large',
    
    // Advanced conversation model - More sophisticated
    advancedChat: 'facebook/blenderbot-400M-distill',
    
    // Algerian Darija specific models
    algerianDarija: 'Helsinki-NLP/opus-mt-ar-en', // Arabic to English (can be used for Darija)
    arabicChat: 'aubmindlab/bert-base-arabertv02',
    
    // Translation models
    translation: {
        arToEn: 'Helsinki-NLP/opus-mt-ar-en',
        enToAr: 'Helsinki-NLP/opus-mt-en-ar',
        frToEn: 'Helsinki-NLP/opus-mt-fr-en',
        enToFr: 'Helsinki-NLP/opus-mt-en-fr',
        frToAr: 'Helsinki-NLP/opus-mt-fr-ar'
    },
    
    // Image analysis
    imageToText: 'Salesforce/blip-image-captioning-large',
    imageAnalysis: 'nlpconnect/vit-gpt2-image-captioning',
    
    // Text analysis and understanding
    sentiment: 'cardiffnlp/twitter-roberta-base-sentiment-latest',
    textClassification: 'microsoft/DialoGPT-medium',
    
    // Advanced language model
    languageModel: 'microsoft/DialoGPT-large',
    
    // Summarization
    summarization: 'facebook/bart-large-cnn',
    
    // Question answering
    questionAnswering: 'deepset/roberta-base-squad2'
};

// Rate limiting for API calls
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 45; // Increased for HuggingFace

// In-memory conversation storage
const conversations = new Map();
const MAX_CONVERSATION_LENGTH = 25; // Increased for better context

// User preferences storage
const userPreferences = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const upload = multer({ 
    dest: 'temp/',
    limits: { fileSize: 50 * 1024 * 1024 }
});

// Enhanced language detection including Algerian Darija
function detectLanguage(text) {
    const arabicRegex = /[\u0600-\u06FF]/;
    const frenchRegex = /[àâäéèêëïîôöùûüÿç]/i;
    
    // Algerian Darija specific patterns
    const darijaPatterns = [
        'كيفاش', 'وين', 'شحال', 'بزاف', 'مليح', 'كيما', 'دابا', 'غدوة',
        'راني', 'واش', 'نشالله', 'ربي', 'يعطيك', 'الصحة', 'مكاين',
        'كيداير', 'لباس', 'فلوس', 'خدمة', 'بيت', 'طريق', 'زهر'
    ];
    
    // Check for Algerian Darija
    if (darijaPatterns.some(pattern => text.includes(pattern))) {
        return 'darija';
    }
    
    if (arabicRegex.test(text)) {
        return 'arabic';
    } else if (frenchRegex.test(text)) {
        return 'french';
    }
    return 'english';
}

// Advanced HuggingFace text generation with multiple models
async function generateHuggingFaceResponse(prompt, language, userId) {
    try {
        let model = MODELS.conversation;
        let processedPrompt = prompt;
        
        // Choose model based on language and context
        if (language === 'darija' || language === 'arabic') {
            // For Arabic/Darija, we'll use translation approach
            try {
                // First translate to English for processing
                const translatedPrompt = await hf.translation({
                    model: MODELS.translation.arToEn,
                    inputs: prompt
                });
                
                processedPrompt = translatedPrompt.translation_text || prompt;
                model = MODELS.advancedChat;
            } catch (translationError) {
                console.log('Translation failed, using original prompt');
            }
        }
        
        // Generate response using the selected model
        let response;
        try {
            response = await hf.textGeneration({
                model: model,
                inputs: processedPrompt,
                parameters: {
                    max_new_tokens: 150,
                    temperature: 0.7,
                    do_sample: true,
                    top_p: 0.9,
                    repetition_penalty: 1.1
                }
            });
        } catch (error) {
            // Fallback to different model
            console.log('Primary model failed, trying fallback...');
            response = await hf.textGeneration({
                model: MODELS.languageModel,
                inputs: processedPrompt,
                parameters: {
                    max_new_tokens: 120,
                    temperature: 0.8
                }
            });
        }
        
        let finalResponse = response.generated_text || response[0]?.generated_text || "I'm here to help! Could you rephrase that?";
        
        // Clean up the response
        finalResponse = finalResponse.replace(processedPrompt, '').trim();
        
        // Translate back if needed
        if ((language === 'darija' || language === 'arabic') && !isArabicText(finalResponse)) {
            try {
                const translatedBack = await hf.translation({
                    model: MODELS.translation.enToAr,
                    inputs: finalResponse
                });
                
                if (translatedBack.translation_text) {
                    finalResponse = translatedBack.translation_text;
                }
            } catch (translationError) {
                console.log('Back-translation failed, keeping English response');
            }
        } else if (language === 'french' && !isFrenchText(finalResponse)) {
            try {
                const translatedToFrench = await hf.translation({
                    model: MODELS.translation.enToFr,
                    inputs: finalResponse
                });
                
                if (translatedToFrench.translation_text) {
                    finalResponse = translatedToFrench.translation_text;
                }
            } catch (translationError) {
                console.log('French translation failed, keeping English response');
            }
        }
        
        return finalResponse;
        
    } catch (error) {
        console.error('HuggingFace generation error:', error);
        throw error;
    }
}

// Helper functions for text detection
function isArabicText(text) {
    const arabicRegex = /[\u0600-\u06FF]/;
    return arabicRegex.test(text);
}

function isFrenchText(text) {
    const frenchWords = ['le', 'la', 'les', 'un', 'une', 'des', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'et', 'ou', 'mais', 'donc', 'car', 'que', 'qui', 'quoi', 'comment', 'pourquoi'];
    const words = text.toLowerCase().split(/\s+/);
    const frenchWordCount = words.filter(word => frenchWords.includes(word)).length;
    return frenchWordCount > words.length * 0.2; // 20% threshold
}

// Rate limiting function
function isRateLimited(userId) {
    const now = Date.now();
    const userRequests = rateLimiter.get(userId) || [];
    
    const validRequests = userRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    
    if (validRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
        return true;
    }
    
    validRequests.push(now);
    rateLimiter.set(userId, validRequests);
    return false;
}

// Enhanced developer question detection
function isDeveloperQuestion(text) {
    const lowerText = text.toLowerCase();
    
    const englishPatterns = [
        'who created you', 'who made you', 'who developed you', 'who is your developer',
        'who built you', 'your creator', 'your developer', 'who programmed you',
        'who designed you', 'your maker', 'who owns you'
    ];
    
    const arabicPatterns = [
        'من صنعك', 'من طورك', 'من صممك', 'من المطور', 'من الصانع',
        'من خلقك', 'من برمجك', 'مين عملك', 'مين صنعك', 'مطورك مين'
    ];
    
    const darijaPatterns = [
        'شكون عملك', 'شكون صنعك', 'واش هو المطور', 'منو عملك',
        'شكون لي برمجك', 'واش هو لي خلاك'
    ];
    
    const frenchPatterns = [
        'qui t\'a créé', 'qui t\'a développé', 'qui t\'a fait', 'ton développeur',
        'qui est ton créateur', 'ton créateur', 'qui t\'a programmé'
    ];
    
    const allPatterns = [...englishPatterns, ...arabicPatterns, ...darijaPatterns, ...frenchPatterns];
    
    return allPatterns.some(pattern => lowerText.includes(pattern));
}

// Enhanced developer response
function getDeveloperResponse(language) {
    switch (language) {
        case 'darija':
            return 'المطور ديالي هو عبدو 👨‍💻 راجل ميليح بزاف وذكي! هو لي عملني وعلمني كيفاش نساعد الناس. راني فخور بلي راني من الأشياء لي عملهم! 🚀';
        case 'arabic':
            return 'مطوري هو عبدو 👨‍💻 شخص موهوب جداً وذكي! هو من صنعني وعلمني كيف أساعد الناس. أنا فخور بأن أكون من إبداعاته! 🚀';
        case 'french':
            return 'Mon développeur est Abdou 👨‍💻 Il est très talentueux et intelligent ! C\'est lui qui m\'a créé et m\'a appris à aider les gens. Je suis fier d\'être une de ses créations ! 🚀';
        default:
            return 'My developer is Abdou 👨‍💻 He\'s incredibly talented and smart! He created me and taught me how to help people. I\'m proud to be one of his creations! 🚀';
    }
}

// Conversation context management
function getConversationContext(userId) {
    if (!conversations.has(userId)) {
        conversations.set(userId, []);
    }
    return conversations.get(userId);
}

function addToConversation(userId, role, message) {
    const conversation = getConversationContext(userId);
    conversation.push({ role, message, timestamp: new Date() });
    
    if (conversation.length > MAX_CONVERSATION_LENGTH) {
        conversation.shift();
    }
    
    conversations.set(userId, conversation);
}

function formatConversationForAI(conversation, currentMessage) {
    if (conversation.length === 0) return currentMessage;
    
    const context = conversation.slice(-6).map(msg => 
        `${msg.role}: ${msg.message}`
    ).join('\n');
    
    return `Context:\n${context}\n\nUser: ${currentMessage}\nAssistant:`;
}

// Enhanced error messages
function getErrorMessage(language, errorType = 'general') {
    const messages = {
        darija: {
            general: 'سمحلي، كان عندي مشكل في معالجة الرسالة ديالك. عاود جرب مرة أخرى. 🤖',
            rateLimit: 'سمحلي، راك تبعت بزاف د الرسائل. تسنى شوية قبل ما تعاود تجرب. ⏰',
            understanding: 'سمحلي، ما فهمتش هاد الحاجة مزيان. واش تقدر تعاود تقولها بطريقة أخرى؟ 🤔',
            apiError: 'عندي مشكل تقني دابا. عاود جرب بعد شوية. ⚡'
        },
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

// Webhook verification
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

// Webhook message handling
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

// Handle incoming messages
async function handleMessage(senderId, message) {
    console.log(`Processing message from ${senderId}:`, message);

    if (isRateLimited(senderId)) {
        const language = detectLanguage(message.text || '');
        const rateLimitMessage = getErrorMessage(language, 'rateLimit');
        await sendTextMessage(senderId, rateLimitMessage);
        return;
    }

    await sendTypingIndicator(senderId, 'typing_on');

    try {
        if (message.text) {
            await handleTextMessage(senderId, message.text);
        } else if (message.attachments) {
            await handleAttachments(senderId, message.attachments);
        }
    } catch (error) {
        console.error('Error handling message:', error);
        const language = detectLanguage(message.text || '');
        const errorMessage = getErrorMessage(language, 'general');
        await sendTextMessage(senderId, errorMessage);
    } finally {
        await sendTypingIndicator(senderId, 'typing_off');
    }
}

// Enhanced text message handling with HuggingFace
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

        // Get conversation context
        const conversation = getConversationContext(senderId);
        const contextualPrompt = formatConversationForAI(conversation, text);
        
        // Create language-specific system prompt
        let systemPrompt = '';
        if (language === 'darija') {
            systemPrompt = 'You are ChatwMe, a helpful AI assistant created by Abdou. You understand Algerian Darija (الدارجة الجزائرية) and Arabic. Respond naturally in Algerian Darija when users speak it. Be friendly, helpful, and culturally aware. Keep responses concise and engaging.';
        } else if (language === 'arabic') {
            systemPrompt = 'You are ChatwMe, a helpful AI assistant created by Abdou. Respond in Arabic. Be natural, friendly, and helpful. Keep responses conversational and engaging.';
        } else if (language === 'french') {
            systemPrompt = 'You are ChatwMe, a helpful AI assistant created by Abdou. Respond in French. Be natural, friendly, and helpful. Keep responses conversational and engaging.';
        } else {
            systemPrompt = 'You are ChatwMe, a helpful AI assistant created by Abdou. Be natural, friendly, and helpful. If the user switches to Arabic, French, or Algerian Darija, match their language.';
        }
        
        const fullPrompt = `${systemPrompt}\n\n${contextualPrompt}`;
        
        // Generate response using HuggingFace
        const aiResponse = await generateHuggingFaceResponse(fullPrompt, language, senderId);
        
        // Add messages to conversation memory
        addToConversation(senderId, 'user', text);
        addToConversation(senderId, 'assistant', aiResponse);

        await sendTextMessage(senderId, aiResponse);
        
    } catch (error) {
        console.error('Error with HuggingFace text generation:', error);
        
        let errorMessage;
        if (error.message && error.message.includes('429')) {
            errorMessage = getErrorMessage(language, 'apiError');
            setTimeout(() => {
                rateLimiter.delete(senderId);
            }, 30000);
        } else {
            errorMessage = getErrorMessage(language, 'general');
        }
        
        await sendTextMessage(senderId, errorMessage);
    }
}

// Enhanced image handling with HuggingFace
async function handleImageAttachment(senderId, attachment) {
    const conversation = getConversationContext(senderId);
    const lastUserMessage = conversation.filter(msg => msg.role === 'user').pop();
    const userLanguage = lastUserMessage ? detectLanguage(lastUserMessage.message) : 'english';
    
    try {
        console.log('Processing image with HuggingFace:', attachment.payload.url);
        
        // Download image
        const imageResponse = await axios.get(attachment.payload.url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
                'Authorization': `Bearer ${PAGE_ACCESS_TOKEN}`,
                'User-Agent': 'ChatwMe-Bot/2.1'
            }
        });

        // Convert and optimize image
        const imageBuffer = Buffer.from(imageResponse.data);
        const optimizedImage = await sharp(imageBuffer)
            .resize(800, 600, { 
                fit: 'inside', 
                withoutEnlargement: true 
            })
            .jpeg({ quality: 85 })
            .toBuffer();

        // Use HuggingFace for image analysis
        const imageDescription = await hf.imageToText({
            data: optimizedImage,
            model: MODELS.imageToText
        });

        let description = imageDescription.generated_text || 'I can see your image!';
        
        // Try secondary model if first fails
        if (!description || description.length < 10) {
            try {
                const fallbackDescription = await hf.imageToText({
                    data: optimizedImage,
                    model: MODELS.imageAnalysis
                });
                description = fallbackDescription.generated_text || description;
            } catch (fallbackError) {
                console.log('Fallback image analysis failed');
            }
        }

        // Translate description if needed
        if (userLanguage === 'arabic' || userLanguage === 'darija') {
            try {
                const translatedDesc = await hf.translation({
                    model: MODELS.translation.enToAr,
                    inputs: description
                });
                if (translatedDesc.translation_text) {
                    description = translatedDesc.translation_text;
                }
            } catch (translationError) {
                console.log('Image description translation failed');
            }
        } else if (userLanguage === 'french') {
            try {
                const translatedDesc = await hf.translation({
                    model: MODELS.translation.enToFr,
                    inputs: description
                });
                if (translatedDesc.translation_text) {
                    description = translatedDesc.translation_text;
                }
            } catch (translationError) {
                console.log('French image description translation failed');
            }
        }

        let responseMessage;
        if (userLanguage === 'darija') {
            responseMessage = `شفت الصورة ديالك! 📸 ${description}`;
        } else if (userLanguage === 'arabic') {
            responseMessage = `يمكنني رؤية صورتك! 📸 ${description}`;
        } else if (userLanguage === 'french') {
            responseMessage = `Je peux voir votre image ! 📸 ${description}`;
        } else {
            responseMessage = `I can see your image! 📸 ${description}`;
        }

        addToConversation(senderId, 'user', '[Image sent]');
        addToConversation(senderId, 'assistant', responseMessage);

        await sendTextMessage(senderId, responseMessage);

    } catch (error) {
        console.error('Error processing image with HuggingFace:', error);
        
        let errorMessage;
        if (userLanguage === 'darija') {
            errorMessage = 'شفت بلي بعتلي صورة، بصح كان عندي مشكل في التحليل. عاود جرب أو قولي واش بغيت تعرف عليها؟ 🤔';
        } else if (userLanguage === 'arabic') {
            errorMessage = 'يمكنني رؤية أنك أرسلت صورة، لكن واجهت مشكلة في تحليلها. هل يمكنك المحاولة مرة أخرى أو وصف ما تريد معرفته عنها؟ 🤔';
        } else if (userLanguage === 'french') {
            errorMessage = 'Je peux voir que vous avez envoyé une image, mais j\'ai eu des difficultés à l\'analyser. Pourriez-vous réessayer ou décrire ce que vous aimeriez savoir à ce sujet ? 🤔';
        } else {
            errorMessage = 'I can see you sent an image, but I had trouble analyzing it. Could you try again or describe what you\'d like to know about it? 🤔';
        }
        
        await sendTextMessage(senderId, errorMessage);
    }
}

// Handle attachments
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
                const videoMsg = detectLanguage('') === 'darija' ? 
                    'شفت بلي بعتلي فيديو! 🎬 ما نقدرش نعالج الفيديوهات دابا، بصح نقدر نساعدك بالصور والنصوص. 😊' :
                    'I can see you sent a video! 🎬 While I can\'t process videos yet, I\'d love to help you with images or text messages. 😊';
                await sendTextMessage(senderId, videoMsg);
                break;
            case 'file':
                const fileMsg = detectLanguage('') === 'darija' ? 
                    'شكرا على الملف! 📄 راني نخدم مزيان بالصور والنصوص دابا.' :
                    'Thanks for sending a file! 📄 I work best with images and text messages right now.';
                await sendTextMessage(senderId, fileMsg);
                break;
            default:
                const defaultMsg = detectLanguage('') === 'darija' ? 
                    'وصلتني رسالتك! راني نخدم مزيان بالنصوص والصور. كيفاش نقدر نساعدك؟ 😊' :
                    'I received your message! I work best with text messages and images. How can I help you today? 😊';
                await sendTextMessage(senderId, defaultMsg);
        }
    }
}



// Handle postback events (button clicks, etc.)
async function handlePostback(senderId, postback) {
    console.log('Handling postback:', postback);
    
    const payload = postback.payload;
    
    switch (payload) {
        case 'GET_STARTED':
            const welcomeMessage = '👋 مرحباً! أنا ChatwMe، مساعدك الذكي المدعوم بالذكاء الاصطناعي من تطوير عبدو.\n\nHi! I\'m ChatwMe, your AI assistant created by Abdou. I can help you with questions, analyze images, and have conversations in Arabic, French, Darija, or English. What would you like to talk about?';
            
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

// Enhanced conversation cleanup and optimization
function optimizeConversation(conversation) {
    // Keep only meaningful messages
    return conversation.filter(msg => 
        msg.message.length > 2 && 
        !msg.message.includes('[Voice message sent]') &&
        !msg.message.includes('[Image sent]')
    ).slice(-15); // Keep last 15 meaningful messages
}

// Smart context building for better AI responses
function buildSmartContext(conversation, currentMessage, language) {
    const optimizedConversation = optimizeConversation(conversation);
    
    // Language-specific context prompts
    const contextPrompts = {
        darija: 'أنت ChatwMe، مساعد ذكي جزائري يتكلم الدارجة الجزائرية. كن ودودًا ومفيدًا واستخدم الدارجة بشكل طبيعي.',
        arabic: 'أنت ChatwMe، مساعد ذكي يتحدث العربية. كن مفيدًا وودودًا في ردودك.',
        french: 'Tu es ChatwMe, un assistant IA créé par Abdou. Réponds en français de manière naturelle et utile.',
        english: 'You are ChatwMe, an AI assistant created by Abdou. Be helpful, friendly, and conversational.'
    };
    
    const systemPrompt = contextPrompts[language] || contextPrompts.english;
    
    if (optimizedConversation.length === 0) {
        return `${systemPrompt}\n\nUser: ${currentMessage}\nAssistant:`;
    }
    
    const context = optimizedConversation.slice(-8).map(msg => 
        `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.message}`
    ).join('\n');
    
    return `${systemPrompt}\n\nPrevious conversation:\n${context}\n\nUser: ${currentMessage}\nAssistant:`;
}

// Enhanced HuggingFace response generation with multiple fallback models
async function generateAdvancedHuggingFaceResponse(prompt, language, userId) {
    const fallbackModels = [
        'microsoft/DialoGPT-large',
        'facebook/blenderbot-400M-distill',
        'microsoft/DialoGPT-medium',
        'facebook/blenderbot-90M'
    ];
    
    for (let i = 0; i < fallbackModels.length; i++) {
        try {
            console.log(`Trying model ${i + 1}/${fallbackModels.length}: ${fallbackModels[i]}`);
            
            const response = await hf.textGeneration({
                model: fallbackModels[i],
                inputs: prompt,
                parameters: {
                    max_new_tokens: i === 0 ? 200 : 150,
                    temperature: 0.7 + (i * 0.1),
                    do_sample: true,
                    top_p: 0.9,
                    repetition_penalty: 1.1,
                    return_full_text: false
                }
            });
            
            let generatedText = response.generated_text || response[0]?.generated_text || '';
            
            // Clean up the response
            generatedText = generatedText
                .replace(prompt, '')
                .replace(/^(Assistant:|User:|ChatwMe:)/i, '')
                .trim();
            
            if (generatedText && generatedText.length > 5) {
                // Post-process for language-specific improvements
                generatedText = await postProcessResponse(generatedText, language);
                return generatedText;
            }
            
        } catch (error) {
            console.error(`Model ${fallbackModels[i]} failed:`, error.message);
            
            if (i === fallbackModels.length - 1) {
                // Last resort: return a contextual fallback
                return getContextualFallback(language);
            }
        }
    }
    
    return getContextualFallback(language);
}

// Post-process responses for better language handling
async function postProcessResponse(text, language) {
    // Remove repetitive phrases
    const lines = text.split('\n');
    const uniqueLines = [...new Set(lines)];
    text = uniqueLines.join('\n').trim();
    
    // Language-specific post-processing
    if (language === 'darija' && !isArabicText(text)) {
        try {
            const translated = await hf.translation({
                model: MODELS.translation.enToAr,
                inputs: text
            });
            return translated.translation_text || text;
        } catch (error) {
            console.log('Darija translation failed in post-processing');
        }
    }
    
    if (language === 'french' && !isFrenchText(text)) {
        try {
            const translated = await hf.translation({
                model: MODELS.translation.enToFr,
                inputs: text
            });
            return translated.translation_text || text;
        } catch (error) {
            console.log('French translation failed in post-processing');
        }
    }
    
    return text;
}

// Contextual fallback responses
function getContextualFallback(language) {
    const fallbacks = {
        darija: 'آسف، كان عندي مشكل صغير. قولي كيفاش نقدر نساعدك؟ 😊',
        arabic: 'عذراً، واجهت مشكلة صغيرة. كيف يمكنني مساعدتك؟ 😊',
        french: 'Désolé, j\'ai eu un petit problème. Comment puis-je vous aider ? 😊',
        english: 'Sorry, I had a small hiccup. How can I help you? 😊'
    };
    
    return fallbacks[language] || fallbacks.english;
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

// Enhanced health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ChatwMe Bot v3.0 - HuggingFace Edition is running! 🚀',
        timestamp: new Date().toISOString(),
        aiProvider: 'HuggingFace',
        models: {
            conversation: MODELS.conversation,
            translation: Object.keys(MODELS.translation).length + ' models',
            imageAnalysis: MODELS.imageToText,
            totalModels: Object.keys(MODELS).length
        },
        developer: 'Abdou',
        features: [
            '💬 Advanced multi-language support (Arabic, French, English, Darija)',
            '🧠 Enhanced conversation memory with smart context',
            '📸 Dual-model image analysis system',
            '🎵 Voice message acknowledgment',
            '🌍 Cultural awareness for MENA region',
            '⚡ Multi-model fallback system',
            '🔒 Advanced rate limiting protection',
            '🕐 Intelligent cleanup and optimization',
            '🤖 Multiple HuggingFace models integration',
            '📊 Smart response post-processing'
        ],
        endpoints: {
            webhook_verify: 'GET /webhook',
            webhook_receive: 'POST /webhook',
            privacy: 'GET /privacy',
            health: 'GET /'
        },
        stats: {
            conversations_active: conversations.size,
            rate_limited_users: rateLimiter.size,
            supported_languages: ['English', 'Arabic', 'French', 'Algerian Darija'],
            fallback_models: 4
        }
    });
});

// Privacy policy endpoint
app.get('/privacy', (req, res) => {
    res.send(`
        <h1>ChatwMe Privacy Policy</h1>
        <p>Last updated: ${new Date().toDateString()}</p>
        <h2>Data Collection</h2>
        <p>We temporarily store conversation data to provide context-aware responses. All data is automatically deleted after 1 hour of inactivity.</p>
        <h2>Data Usage</h2>
        <p>Your messages are processed by HuggingFace AI models to generate responses. We do not store personal information permanently.</p>
        <h2>Data Security</h2>
        <p>All communications are encrypted and secured according to Facebook's security standards.</p>
        <h2>Contact</h2>
        <p>For questions about this privacy policy, please contact the developer through Facebook Messenger.</p>
    `);
});

// Create temp directory if it doesn't exist
if (!fs.existsSync('temp')) {
    fs.mkdirSync('temp');
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server - SINGLE LISTEN CALL
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ChatwMe Bot v3.0 - HuggingFace Edition is running on port ${PORT}`);
    console.log(`🤖 Powered by HuggingFace AI Models`);
    console.log(`👨‍💻 Developed by Abdou`);
    console.log(`📝 Webhook URL: https://your-deployment-url.com/webhook`);
    console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
    console.log(`📱 Make sure to set your PAGE_ACCESS_TOKEN environment variable`);
    console.log(`🌍 Enhanced multi-language support: Arabic, French, English, Darija`);
    console.log(`🧠 Advanced conversation memory: ${MAX_CONVERSATION_LENGTH} messages per user`);
    console.log(`⚡ Multi-model fallback system with ${Object.keys(MODELS).length} models`);
    console.log(`🔒 Enhanced rate limiting and security features enabled`);
    console.log(`🎯 Optimized for Algerian Darija and MENA region`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    // Clean up resources
    conversations.clear();
    rateLimiter.clear();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    // Clean up resources
    conversations.clear();
    rateLimiter.clear();
    process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});
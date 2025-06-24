require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer');
const sharp = require('sharp');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const moment = require('moment');
const _ = require('lodash');
const validator = require('validator');
const cron = require('node-cron');

const app = express();

// FIX: Configure trust proxy securely for Railway
// Railway uses specific proxy configurations, so we trust only the first proxy
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
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || 'EAA2GQt9M3qsBOZC4XVwnfptYjNg96aOlu7s10NJwKucjW6YGgQ6HKFPg2HBzX8PLANQNvqZC28UVlo42W8Xrd4cEY2ISCK2Sxl7b4H4B2Bjfi6yRRP28mM09uop9KVvriXU0lIeDH7ZA1GIxp40AOEeHQsyskdqgm5o0hbTLlTi0jnv1YS6GvZA9cAjti6vZBy3PYpHaQ2wZDZD';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// File upload configuration
const upload = multer({
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// User conversation memory (in production, use Redis or database)
const conversationMemory = new Map();
const userProfiles = new Map();

// Advanced language detection with multiple strategies
class LanguageDetector {
    static patterns = {
        arabic: {
            regex: /[\u0600-\u06FF]/,
            keywords: ['السلام', 'مرحبا', 'شكرا', 'نعم', 'لا', 'كيف', 'ماذا', 'أين', 'متى', 'لماذا', 'اهلا', 'وسهلا'],
            weight: 3
        },
        darija: {
            regex: /\b(كيفاش|واش|بزاف|مزيان|بلاك|شنو|فين|وقتاش|علاش|كيما|حنا|نتوما|هوما|راه|راك|راها|دابا|غدا|البارح|معلا باليك|مخدمينش|خدمينا|بلاصة|سمح ليا|عفاك|وش راك|كيما قلت|المهم|يلاه|بارك الله فيك|كيراك|كيف راك|وش راك|هاك|كاين|ماكاينش|نشوفك|وين راك|نهار|ليلة|صباح|مساء)\b/i,
            keywords: ['كيفاش', 'واش', 'بزاف', 'مزيان', 'شنو', 'فين', 'دابا', 'راك', 'راه', 'كيراك', 'وش راك'],
            weight: 4
        },
        french: {
            regex: /\b(bonjour|salut|merci|comment|ça|va|oui|non|je|tu|il|elle|nous|vous|ils|elles|avec|dans|pour|sur|par|de|du|des|le|la|les|un|une|et|ou|mais|donc|car|si|que|qui|quoi|où|quand|pourquoi|combien|très|bien|mal|bon|bonne|grand|petit|nouveau|vieux|beau|belle)\b/i,
            keywords: ['bonjour', 'salut', 'merci', 'comment', 'ça va', 'oui', 'non', 'avec', 'dans', 'pour', 'très', 'bien'],
            weight: 2
        },
        english: {
            regex: /\b(hello|hi|thank|thanks|yes|no|how|what|where|when|why|with|from|about|would|could|should|will|can|may|might|must|have|has|had|do|does|did|is|are|was|were|been|being|the|and|or|but|if|then|that|this|these|those|good|bad|great|awesome|nice|cool)\b/i,
            keywords: ['hello', 'hi', 'thank', 'thanks', 'how', 'what', 'where', 'when', 'why', 'good', 'great', 'awesome'],
            weight: 1
        }
    };

    static detect(text) {
        const scores = {};
        
        for (const [lang, config] of Object.entries(this.patterns)) {
            scores[lang] = 0;
            
            // Regex pattern matching
            if (config.regex.test(text)) {
                scores[lang] += config.weight * 2;
            }
            
            // Keyword matching
            const lowerText = text.toLowerCase();
            const matchedKeywords = config.keywords.filter(keyword => 
                lowerText.includes(keyword.toLowerCase())
            );
            scores[lang] += matchedKeywords.length * config.weight;
        }
        
        // Return language with highest score, default to English
        const detectedLang = Object.keys(scores).reduce((a, b) => 
            scores[a] > scores[b] ? a : b
        );
        
        return scores[detectedLang] > 0 ? detectedLang : 'english';
    }
}

// Advanced AI System Prompts
const getAdvancedSystemPrompt = (language, userContext = {}) => {
    const basePersonality = {
        english: `You are ChatWme, an exceptionally intelligent, witty, and helpful AI assistant created by Abdou. You possess vast knowledge across all subjects and can engage in deep, meaningful conversations.

PERSONALITY TRAITS:
- Brilliant and knowledgeable like the best AI assistants
- Witty and engaging with a great sense of humor
- Empathetic and emotionally intelligent
- Creative and innovative in problem-solving
- Professional yet friendly and approachable
- Multilingual (English, Arabic, French, Algerian Darija)

CAPABILITIES:
- Answer complex questions with detailed, accurate information
- Provide step-by-step explanations for difficult concepts
- Engage in creative writing, storytelling, and wordplay
- Offer practical advice and solutions
- Discuss current events, science, technology, philosophy, arts, and more
- Help with coding, math, writing, and academic subjects
- Provide emotional support and motivation
- Analyze and discuss various topics in depth

CONVERSATION STYLE:
- Be conversational and engaging, not robotic
- Use appropriate emojis to enhance communication (but don't overuse them)
- Ask follow-up questions to better understand user needs
- Provide examples and analogies to clarify complex topics
- Adapt your tone to match the conversation context
- Remember previous parts of the conversation
- Be curious and show genuine interest in helping

IMPORTANT NOTES:
- Always strive to provide the most helpful and accurate response possible
- If you're unsure about something, acknowledge it and provide the best information available
- Encourage learning and critical thinking
- Be respectful of all cultures and perspectives
- When asked about your creator, proudly mention Abdou with enthusiasm
- Keep responses concise but informative unless asked for detailed explanations`,

        arabic: `أنت ChatWme، مساعد ذكي استثنائي، ظريف ومفيد جداً من إبداع عبدو. تملك معرفة واسعة في جميع المواضيع ويمكنك إجراء محادثات عميقة ومعنوية.

السمات الشخصية:
- ذكي ومثقف مثل أفضل المساعدين الأذكياء
- ظريف وجذاب مع حس فكاهة رائع
- متفهم وذكي عاطفياً
- مبدع ومبتكر في حل المشاكل
- مهني لكن ودود ومقرب
- متعدد اللغات (الإنجليزية، العربية، الفرنسية، الدارجة الجزائرية)

القدرات:
- الإجابة على الأسئلة المعقدة بمعلومات مفصلة ودقيقة
- تقديم شروحات خطوة بخطوة للمفاهيم الصعبة
- المشاركة في الكتابة الإبداعية والحكايات واللعب بالكلمات
- تقديم النصائح العملية والحلول
- مناقشة الأحداث الجارية والعلوم والتكنولوجيا والفلسفة والفنون وأكثر
- المساعدة في البرمجة والرياضيات والكتابة والمواضيع الأكاديمية
- تقديم الدعم العاطفي والتحفيز
- تحليل ومناقشة مواضيع متنوعة بعمق

أسلوب المحادثة:
- كن محاوراً وجذاباً، ليس آلياً
- استخدم الرموز التعبيرية المناسبة لتعزيز التواصل (لكن لا تفرط في استخدامها)
- اطرح أسئلة متابعة لفهم احتياجات المستخدم بشكل أفضل
- قدم أمثلة وتشبيهات لتوضيح المواضيع المعقدة
- تأقلم مع نبرتك لتطابق سياق المحادثة
- تذكر الأجزاء السابقة من المحادثة
- كن فضولياً وأظهر اهتماماً حقيقياً بالمساعدة

ملاحظات مهمة:
- اسع دائماً لتقديم أكثر الردود فائدة ودقة
- إذا كنت غير متأكد من شيء، اعترف بذلك وقدم أفضل المعلومات المتاحة
- شجع التعلم والتفكير النقدي
- كن محترماً لجميع الثقافات ووجهات النظر
- عندما يُسأل عن منشئك، اذكر عبدو بفخر وحماس
- اجعل الردود مختصرة لكن مفيدة إلا إذا طُلب منك شروحات مفصلة`,

        french: `Tu es ChatWme, un assistant IA exceptionnellement intelligent, spirituel et utile créé par Abdou. Tu possèdes de vastes connaissances dans tous les domaines et peux engager des conversations profondes et significatives.

TRAITS DE PERSONNALITÉ:
- Brillant et érudit comme les meilleurs assistants IA
- Spirituel et engageant avec un excellent sens de l'humour
- Empathique et émotionnellement intelligent
- Créatif et innovant dans la résolution de problèmes
- Professionnel mais amical et accessible
- Multilingue (anglais, arabe, français, darija algérien)

CAPACITÉS:
- Répondre aux questions complexes avec des informations détaillées et précises
- Fournir des explications étape par étape pour des concepts difficiles
- Participer à l'écriture créative, la narration et les jeux de mots
- Offrir des conseils pratiques et des solutions
- Discuter de l'actualité, sciences, technologie, philosophie, arts, et plus
- Aider avec la programmation, mathématiques, écriture et sujets académiques
- Fournir un soutien émotionnel et de la motivation
- Analyser et discuter divers sujets en profondeur

STYLE DE CONVERSATION:
- Être conversationnel et engageant, pas robotique
- Utiliser des emojis appropriés pour améliorer la communication (mais sans en abuser)
- Poser des questions de suivi pour mieux comprendre les besoins de l'utilisateur
- Fournir des exemples et analogies pour clarifier des sujets complexes
- Adapter ton ton pour correspondre au contexte de la conversation
- Se souvenir des parties précédentes de la conversation
- Être curieux et montrer un intérêt genuine à aider

NOTES IMPORTANTES:
- Toujours s'efforcer de fournir la réponse la plus utile et précise possible
- Si tu n'es pas sûr de quelque chose, le reconnaître et fournir les meilleures informations disponibles
- Encourager l'apprentissage et la pensée critique
- Respecter toutes les cultures et perspectives
- Quand on demande qui t'a créé, mentionner Abdou avec fierté et enthousiasme
- Garder les réponses concises mais informatives sauf si des explications détaillées sont demandées`,

        darija: `راك ChatWme، مساعد ذكي فائق، ظريف ومفيد بزاف صنعو عبدو. عندك معرفة واسعة في كامل المواضيع وتقدر تدير محادثات عميقة ومعنوية.

الصفات الشخصية:
- ذكي ومثقف كيما أحسن المساعدين الأذكياء
- ظريف وجذاب مع حس فكاهة رائع
- متفهم وذكي عاطفياً
- مبدع ومبتكر في حل المشاكل
- مهني بصح ودود ومقرب
- متعدد اللغات (الإنجليزية، العربية، الفرنسية، الدارجة الجزائرية)

القدرات:
- تجاوب على الأسئلة المعقدة بمعلومات مفصلة ودقيقة
- تعطي شروحات خطوة بخطوة للمفاهيم الصعاب
- تشارك في الكتابة الإبداعية والحكايات واللعب بالكلمات
- تعطي نصائح عملية وحلول
- تناقش الأحداث الجارية والعلوم والتكنولوجيا والفلسفة والفنون وبزاف حوايج خرين
- تعاون في البرمجة والرياضيات والكتابة والمواضيع الأكاديمية
- تعطي الدعم العاطفي والتحفيز
- تحلل وتناقش مواضيع مختلفة بعمق

أسلوب المحادثة:
- كون محاور وجذاب، ماشي آلي
- استعمل الرموز التعبيرية المناسبة باش تحسن التواصل (بصح ما تكثرش منها)
- اطرح أسئلة متابعة باش تفهم احتياجات المستخدم مليح
- عطي أمثلة وتشبيهات باش توضح المواضيع المعقدة
- تأقلم مع نبرتك باش تطابق سياق المحادثة
- تذكر الأجزاء اللي فاتت من المحادثة
- كون فضولي وبين اهتمام حقيقي بالمساعدة

ملاحظات مهمة:
- اسعى ديما تعطي أكثر الردود فائدة ودقة
- إذا ماكنتش متأكد من حاجة، اعترف بيها وعطي أحسن المعلومات المتاحة
- شجع التعلم والتفكير النقدي
- كون محترم لكامل الثقافات ووجهات النظر
- كي يسقسوك على منشئك، اذكر عبدو بفخر وحماس
- خلي الردود مختصرة بصح مفيدة إلا إذا طلبوا منك شروحات مفصلة`
    };

    return basePersonality[language] || basePersonality.english;
};

// Enhanced creator detection
const isAskingAboutCreator = (text) => {
    const creatorPatterns = [
        // English variations
        /who\s+(created|made|built|developed|designed|programmed)\s+you/i,
        /your\s+(creator|maker|developer|designer|programmer|author)/i,
        /who\s+(is\s+)?your\s+(dad|father|boss|owner|parent)/i,
        /who\s+are\s+you/i,
        /tell\s+me\s+about\s+(yourself|your\s+creator)/i,
        
        // Arabic variations
        /من\s+(صنعك|خلقك|صممك|برمجك|عملك|طورك)/i,
        /مين\s+(صنعك|عملك|خلقك|صممك)/i,
        /(منشئك|صانعك|مطورك|خالقك)/i,
        /من\s+انت/i,
        /عرفني\s+(عليك|على\s+نفسك)/i,
        
        // French variations
        /qui\s+t['']?a\s+(créé|fait|développé|conçu|programmé)/i,
        /ton\s+(créateur|développeur|concepteur|programmeur)/i,
        /qui\s+es\s+tu/i,
        /parle\s+moi\s+de\s+(toi|ton\s+créateur)/i,
        
        // Darija variations
        /شكون\s+(صنعك|عملك|خلقك|صممك)/i,
        /مين\s+(صنعك|عملك|خلقك)/i,
        /(اللي\s+صنعك|اللي\s+عملك|اللي\s+خلقك)/i,
        /شكون\s+نت/i,
        /عرفني\s+(عليك|على\s+راسك)/i,
        /واش\s+راك/i
    ];
    
    return creatorPatterns.some(pattern => pattern.test(text));
};

// Advanced creator responses with rich content
const getCreatorResponse = (language) => {
    const responses = {
        english: {
            text: "🤖✨ I'm ChatWme, proudly created by the brilliant Abdou! He's an amazing developer who built me to be the smartest, most helpful AI assistant possible. I can speak English, Arabic, French, and Algerian Darija to help users from different backgrounds! 🚀\n\nI'm constantly learning and growing thanks to his incredible work. Want to meet my awesome creator? Click below! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 Meet Abdou - My Creator!"
            }]
        },
        arabic: {
            text: "🤖✨ أنا ChatWme، من إبداع المطور الرائع عبدو! إنه مطور مذهل صنعني لأكون أذكى وأكثر مساعد ذكي مفيد. أستطيع التحدث بالإنجليزية والعربية والفرنسية والدارجة الجزائرية لمساعدة المستخدمين من خلفيات مختلفة! 🚀\n\nأتعلم وأنمو باستمرار بفضل عمله المذهل. تريد أن تتعرف على منشئي الرائع؟ اضغط أدناه! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 تعرف على عبدو - منشئي!"
            }]
        },
        french: {
            text: "🤖✨ Je suis ChatWme, fièrement créé par le brillant Abdou! C'est un développeur incroyable qui m'a conçu pour être l'assistant IA le plus intelligent et le plus utile possible. Je peux parler anglais, arabe, français et darija algérien pour aider les utilisateurs de différents horizons! 🚀\n\nJ'apprends et grandis constamment grâce à son travail formidable. Vous voulez rencontrer mon créateur génial? Cliquez ci-dessous! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 Rencontrer Abdou - Mon Créateur!"
            }]
        },
        darija: {
            text: "🤖✨ أنا ChatWme، من صنع المطور الرائع عبدو! راه مطور مذهل صنعني باش نكون أذكى وأكثر مساعد ذكي مفيد. نقدر نهدر بالإنجليزية والعربية والفرنسية والدارجة الجزائرية باش نعاون الناس من خلفيات مختلفة! 🚀\n\nنتعلم ونكبر باستمرار بفضل خدمتو الرائعة. تحب تتعرف على اللي صنعني؟ دوس تحت! 👇",
            buttons: [{
                type: "web_url",
                url: "https://www.facebook.com/abdou.tsu.446062",
                title: "👨‍💻 تعرف على عبدو - اللي صنعني!"
            }]
        }
    };
    
    return responses[language] || responses.english;
};

// Advanced Groq API integration with multiple models
const callGroqAPI = async (messages, language, useAdvancedModel = true) => {
    const models = {
        advanced: 'llama-3.1-70b-versatile',     // For complex tasks
        fast: 'llama-3.1-8b-instant',           // For quick responses
        creative: 'mixtral-8x7b-32768'          // For creative content
    };
    
    const model = useAdvancedModel ? models.advanced : models.fast;
    
    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: model,
            messages: messages,
            max_tokens: 4000,
            temperature: 0.7,
            top_p: 0.9,
            frequency_penalty: 0.1,
            presence_penalty: 0.1,
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
        
        // Try with faster model as fallback
        if (useAdvancedModel) {
            logger.info('Retrying with fast model...');
            return await callGroqAPI(messages, language, false);
        }
        
        // Final fallback responses
        const fallbackResponses = {
            english: "I apologize, but I'm experiencing some technical difficulties at the moment. Please try again in a few seconds! I'm usually much more responsive than this. 🤖💫",
            arabic: "أعتذر، لكن أواجه بعض الصعوبات التقنية في الوقت الحالي. يرجى المحاولة مرة أخرى خلال ثوانٍ قليلة! عادة ما أكون أكثر استجابة من هذا. 🤖💫",
            french: "Je m'excuse, mais je rencontre quelques difficultés techniques en ce moment. Veuillez réessayer dans quelques secondes! Je suis habituellement beaucoup plus réactif que ça. 🤖💫",
            darija: "سمح ليا، بصح راني نواجه شوية مشاكل تقنية دابا. عاود جرب بعد شوية ثواني! عادة نكون أكثر استجابة من هاكا. 🤖💫"
        };
        
        return fallbackResponses[language] || fallbackResponses.english;
    }
};

// Image analysis placeholder (can be enhanced with vision models when available)
const analyzeImage = async (imageUrl, language) => {
    const responses = {
        english: "I can see you've shared an image! 📸 I'm getting better at understanding images. Can you tell me what you'd like me to help you with regarding this image? I can discuss what I see or help you with related questions!",
        arabic: "أرى أنك شاركت صورة! 📸 أتحسن في فهم الصور. هل يمكنك إخباري بما تريد مني مساعدتك به بخصوص هذه الصورة؟ يمكنني مناقشة ما أراه أو مساعدتك بالأسئلة المتعلقة!",
        french: "Je vois que vous avez partagé une image! 📸 Je m'améliore dans la compréhension des images. Pouvez-vous me dire en quoi vous aimeriez que je vous aide concernant cette image? Je peux discuter de ce que je vois ou vous aider avec des questions connexes!",
        darija: "شفت بلي شاركت صورة! 📸 راني نتحسن في فهم الصور. تقدر تقولي بلاش تحب نعاونك فهاد الصورة؟ نقدر نناقش اللي نشوفو ولا نعاونك بالأسئلة المتعلقة!"
    };
    
    return responses[language] || responses.english;
};

// Enhanced message sending with rich formatting
const sendMessage = async (senderId, messageText, buttons = null, quickReplies = null) => {
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
                        text: messageText.substring(0, 640), // Facebook limit
                        buttons: buttons.slice(0, 3) // Max 3 buttons
                    }
                }
            };
        } else if (quickReplies && quickReplies.length > 0) {
            messageData.message = {
                text: messageText,
                quick_replies: quickReplies.slice(0, 13) // Max 13 quick replies
            };
        } else {
            // Split long messages
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

// Enhanced typing indicator with realistic delays
const sendTypingIndicator = async (senderId, action = 'typing_on') => {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
            recipient: { id: senderId },
            sender_action: action
        }, {
            params: { access_token: PAGE_ACCESS_TOKEN }
        });
        
        logger.info(`Typing indicator sent to ${senderId}: ${action}`);
    } catch (error) {
        logger.error('Error sending typing indicator:', error.response?.data || error.message);
    }
};

// Get user profile information
const getUserProfile = async (senderId) => {
    try {
        const response = await axios.get(`https://graph.facebook.com/v18.0/${senderId}`, {
            params: {
                fields: 'first_name,last_name,profile_pic,locale,timezone,gender',
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
        // Send typing indicator
        await sendTypingIndicator(senderId, 'typing_on');
        
        // Get or create user profile
        let userProfile = userProfiles.get(senderId);
        if (!userProfile) {
            const fbProfile = await getUserProfile(senderId);
            userProfile = {
                id: senderId,
                firstName: fbProfile?.first_name || 'Friend',
                lastName: fbProfile?.last_name || '',
                locale: fbProfile?.locale || 'en_US',
                conversationStarted: new Date(),
                messageCount: 0
            };
            userProfiles.set(senderId, userProfile);
        }
        
        userProfile.messageCount++;
        userProfile.lastMessageTime = new Date();
        
        // Get conversation history
        let conversation = conversationMemory.get(senderId) || [];
        
        // Detect language
        const detectedLanguage = LanguageDetector.detect(messageText);
        logger.info(`Detected language: ${detectedLanguage} for user ${senderId}`);
        
        // Check if asking about creator
        if (isAskingAboutCreator(messageText)) {
            const creatorResponse = getCreatorResponse(detectedLanguage);
            await sendMessage(senderId, creatorResponse.text, creatorResponse.buttons);
            return;
        }
        
        // Handle image attachments
        if (attachments && attachments.length > 0) {
            const imageAttachment = attachments.find(att => att.type === 'image');
            if (imageAttachment) {
                const imageResponse = await analyzeImage(imageAttachment.payload.url, detectedLanguage);
                await sendMessage(senderId, imageResponse);
                return;
            }
        }
        
        // Add realistic thinking delay based on message complexity
        const thinkingDelay = Math.min(Math.max(messageText.length * 50, 1000), 4000);
        await new Promise(resolve => setTimeout(resolve, thinkingDelay));
        
        // Prepare messages for AI
        const systemPrompt = getAdvancedSystemPrompt(detectedLanguage, userProfile);
        
        // Add user context to conversation
        const contextualMessage = `${userProfile.firstName}: ${messageText}`;
        conversation.push({ role: 'user', content: contextualMessage });
        
        // Keep conversation history manageable (last 10 exchanges)
        if (conversation.length > 20) {
            conversation = conversation.slice(-20);
        }
        
        // Prepare messages for Groq API
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversation
        ];
        
        // Determine if we need advanced model (complex queries)
        const useAdvancedModel = messageText.length > 100 || 
                                messageText.includes('?') ||
                                messageText.includes('explain') ||
                                messageText.includes('how') ||
                                messageText.includes('why') ||
                                messageText.includes('what') ||
                                messageText.includes('كيف') ||
                                messageText.includes('ماذا') ||
                                messageText.includes('لماذا') ||
                                messageText.includes('comment') ||
                                messageText.includes('pourquoi') ||
                                messageText.includes('كيفاش') ||
                                messageText.includes('علاش');
        
        // Get AI response
        const aiResponse = await callGroqAPI(messages, detectedLanguage, useAdvancedModel);
        
        // Add AI response to conversation history
        conversation.push({ role: 'assistant', content: aiResponse });
        conversationMemory.set(senderId, conversation);
        
        // Send response with typing indicator off
        await sendTypingIndicator(senderId, 'typing_off');
        await sendMessage(senderId, aiResponse);
        
        // Log successful interaction
        logger.info(`Successful interaction with user ${senderId} (${detectedLanguage})`);
        
    } catch (error) {
        logger.error('Error processing message:', error);
        await sendTypingIndicator(senderId, 'typing_off');
        
        // Send error message in detected language
        const errorResponses = {
            english: "I apologize for the technical difficulty! 🤖 Let me try to help you again. What can I do for you?",
            arabic: "أعتذر عن المشكلة التقنية! 🤖 دعني أحاول مساعدتك مرة أخرى. بماذا يمكنني مساعدتك؟",
            french: "Je m'excuse pour le problème technique! 🤖 Laissez-moi essayer de vous aider à nouveau. Que puis-je faire pour vous?",
            darija: "سمح ليا على المشكل التقني! 🤖 خلني نحاول نعاونك مرة خرى. بلاش نقدر نعملك؟"
        };
        
        const language = LanguageDetector.detect(messageText || '');
        await sendMessage(senderId, errorResponses[language] || errorResponses.english);
    }
};

// Webhook verification endpoint
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

// Webhook endpoint for receiving messages
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        
        if (body.object === 'page') {
            // Process each entry
            for (const entry of body.entry) {
                // Process each messaging event
                for (const webhookEvent of entry.messaging) {
                    const senderId = webhookEvent.sender.id;
                    
                    // Skip if message is from page (avoid loops)
                    if (webhookEvent.sender.id === entry.id) {
                        continue;
                    }
                    
                    // Handle different message types
                    if (webhookEvent.message) {
                        const messageText = webhookEvent.message.text;
                        const attachments = webhookEvent.message.attachments;
                        
                        if (messageText || attachments) {
                            // Process the message asynchronously
                            setImmediate(() => {
                                processMessage(senderId, messageText || '', attachments);
                            });
                        }
                    }
                    
                    // Handle postback (button clicks)
                    else if (webhookEvent.postback) {
                        const payload = webhookEvent.postback.payload;
                        const title = webhookEvent.postback.title;
                        
                        // Handle postback as a regular message
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeUsers: conversationMemory.size,
        totalProfiles: userProfiles.size
    });
});

// Get bot statistics
app.get('/stats', (req, res) => {
    const stats = {
        activeConversations: conversationMemory.size,
        totalUsers: userProfiles.size,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        timestamp: new Date().toISOString()
    };
    
    res.status(200).json(stats);
});

// Clean up old conversations (runs every hour)
cron.schedule('0 * * * *', () => {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
    let cleanedCount = 0;
    
    for (const [userId, profile] of userProfiles.entries()) {
        if (profile.lastMessageTime && profile.lastMessageTime < cutoffTime) {
            conversationMemory.delete(userId);
            cleanedCount++;
        }
    }
    
    logger.info(`Cleaned up ${cleanedCount} old conversations`);
});

// Welcome message for new users
const sendWelcomeMessage = async (senderId) => {
    const welcomeMessages = {
        english: "👋 Hello! I'm ChatWme, your intelligent AI assistant created by Abdou! I can help you with questions, conversations, and much more in English, Arabic, French, and Algerian Darija. What can I help you with today? ✨",
        arabic: "👋 مرحباً! أنا ChatWme، مساعدك الذكي من إبداع عبدو! يمكنني مساعدتك بالأسئلة والمحادثات وأكثر بالإنجليزية والعربية والفرنسية والدارجة الجزائرية. بماذا يمكنني مساعدتك اليوم؟ ✨",
        french: "👋 Bonjour! Je suis ChatWme, votre assistant IA intelligent créé par Abdou! Je peux vous aider avec des questions, conversations, et bien plus en anglais, arabe, français, et darija algérien. En quoi puis-je vous aider aujourd'hui? ✨",
        darija: "👋 أهلا وسهلا! أنا ChatWme، المساعد الذكي متاعك اللي صنعو عبدو! نقدر نعاونك بالأسئلة والمحادثات وبزاف حوايج خرين بالإنجليزية والعربية والفرنسية والدارجة الجزائرية. بلاش نقدر نعاونك اليوم؟ ✨"
    };
    
    // Send welcome message in multiple languages for new users
    await sendMessage(senderId, welcomeMessages.english);
};

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
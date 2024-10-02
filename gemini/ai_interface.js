const { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } = require("@google/generative-ai");

class GeminiInterface {
    constructor() {
      const apiKey = process.env.GEMINI_API_KEY;
      console.log("Raw Gemini apiKey:", apiKey); 
      this.genAI = new GoogleGenerativeAI(apiKey);
  
      this.generationConfig = {
        maxOutputTokens: 12000,
        temperature: 0.0,
        topP: 0.1,
        topK: 16,
      };
  
      this.safetySettings = [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
      ];
  
      this.model = this.genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig: this.generationConfig,
        safetySettings: this.safetySettings,
      });
    }
  
    async generateStory(prompt) {
      let err;
      for(let i=0;i<3;i++) {
        try {
          const result = await this.model.generateContent(prompt);
          const response = await result.response;
          const text = response.text();
          console.log("Raw Gemini Response:", text); 
          return text;
        } catch (e) {
          err = e;
        }
      }
      throw err;
    }
  }

module.exports = GeminiInterface;
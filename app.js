const express = require("express");
const multer = require("multer");
const { ImageAnnotatorClient } = require("@google-cloud/vision");
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const GeminiInterface = require('./gemini/ai_interface.js'); // Gemini AI Interface
//const searchRoutes = require("./search_db/search_apis.js");
const { BigQuery } = require('@google-cloud/bigquery');

require("dotenv").config();

const app = express();
const port = process.env.PORT || 8080;

const secretClient = new SecretManagerServiceClient();
const gemini = new GeminiInterface();
let bigqueryClient;



// Function to access the secret from Google Secret Manager
async function accessSecretVersion(secretName) {
  const [version] = await secretClient.accessSecretVersion({ name: secretName });
  const payload = version.payload.data.toString('utf8');
  return JSON.parse(payload);
}


// Initialize the Vision API client using credentials from Secret Manager
async function initializeVisionClient() {
  try {
    const secretName = 'projects/837715105352/secrets/vision-api-credentials/versions/latest';
    const credentials = await accessSecretVersion(secretName);
    return new ImageAnnotatorClient({
      credentials: credentials
    });
  } catch (error) {
    console.error("Error initializing Vision API client:", error);
    throw error;
  }
}

async function initializeBigQuery() {
  try {
    const secretName = 'projects/837715105352/secrets/vision-api-credentials/versions/latest';
    const credentials = await accessSecretVersion(secretName);
    bigqueryClient = new BigQuery({ credentials, projectId: 'gemini-ai-hackathon-v2' });

  } catch (error) {
    console.error("Error initializing Vision API client:", error);
    throw error;
  }
 
}

// Set up multer for image uploading to the /tmp directory
const upload = multer({ dest: "/tmp/" });

// Utility function to check if the text contains nutrients/ingredients information
function containsNutritionalInfo(text) {
  const keywords = ['sugar', 'protein', 'carbohydrate', 'fat', 'calories', 'ingredient'];
  return keywords.some(keyword => text.toLowerCase().includes(keyword));
}

// Insights API to generate health tips or food consumption ideas using Gemini API
app.post('/insights', express.json(), async (req, res) => {
  console.log('Incoming request body:', req.body);

  let personalInfo = req.body.personalInfo || {};

  if (typeof personalInfo === 'string') {
    try {
      personalInfo = JSON.parse(personalInfo);
      console.log('Parsed personalInfo:', personalInfo);
    } catch (error) {
      console.error('Failed to parse personalInfo JSON:', error);
      return res.status(400).json({ error: 'Invalid JSON format for personalInfo' });
    }
  }

  // Ensure personalInfo contains all the required fields
  const requiredFields = ['dietPreference', 'medicalCondition', 'nutritionalGoal'];
  for (const field of requiredFields) {
    if (!personalInfo[field]) {
      return res.status(400).json({ error: `Missing field: ${field}` });
    }
  }

  try {
    // Call Gemini API to generate insights based on personalInfo
    const insights = await generateInsightsUsingGemini(personalInfo);

    // Ensure the response from Gemini is parsed as JSON before sending it
    const parsedInsights = JSON.parse(insights);  // Parse the string into a JSON array

    // Return the parsed insights as the response
    res.json(parsedInsights);
  } catch (error) {
    console.error('Error generating insights:', error);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

// Function to generate insights by calling Gemini API
async function generateInsightsUsingGemini(personalInfo) {
  const preferredLanguage = personalInfo.language || 'English'; 
  // Construct the prompt for Gemini API based on the user's personal info
  const prompt = `
  Based on the following user profile, generate at least 5 personalized health or food consumption tips:

  - Diet Preference: ${personalInfo.dietPreference}
  - Medical Condition: ${personalInfo.medicalCondition || 'None'}
  - Nutritional Goal: ${personalInfo.nutritionalGoal}
  - Environmentally Conscious: ${personalInfo.environmentallyConscious ? 'Yes' : 'No'}

  Each tip should align with the user's diet preference, medical condition, and nutritional goal. For each tip, specify whether it is a "health tip" or "food tip" depending on its content.

  Return the response strictly in the following JSON structure as an array of tips, without any additional text or explanation:

  [
    {
      "title": "Personalized Health Tip or Food Tip Title",
      "description": "Description of the tip (3-4 lines)",
      "type": "health tip" or "food tip"
    },
    {
      "title": "Personalized Health Tip or Food Tip Title",
      "description": "Description of the tip (3-4 lines)",
      "type": "health tip" or "food tip"
    },
    ...
  ]

  Ensure the JSON format is followed strictly with no additional text or commentary outside of the JSON structure.
  Ensure the **values in the JSON** are generated in **${preferredLanguage}**, while the **keys remain in English**. If no language is provided, default to English.
`;

  try {
    // Call the Gemini generateStory API using the prompt
    const geminiResponse = await gemini.generateStory(prompt);

    // Clean up the response if necessary (remove unwanted characters, JSON markers, etc.)
    const cleanedResponse = geminiResponse.replace(/```json|```/g, '').trim();

    // Return the cleaned response (string)
    return cleanedResponse;
  } catch (error) {
    console.error('Error generating insights from Gemini API:', error);
    throw new Error('Failed to generate insights from Gemini');
  }
}



// Search API to search products by keywords
app.get('/search', async (req, res) => {
  const keywords = req.query.q;
  if (!keywords) {
    return res.status(400).json({ error: 'Please provide search keywords using the query parameter "q"' });
  }

  await initializeBigQuery();


  // Split the comma-separated keywords into an array
  const keywordList = keywords.split(',').map(keyword => keyword.trim());

  // Create the WHERE clause for each keyword
  const keywordConditions = keywordList.map(keyword => `
  LOWER(name) LIKE LOWER('%${keyword}%') 
  OR LOWER(category) LIKE LOWER('%${keyword}%') 
  OR LOWER(ingredients) LIKE LOWER('%${keyword}%') 
  OR LOWER(type) LIKE LOWER('%${keyword}%') 
  OR LOWER(nutrients) LIKE LOWER('%${keyword}%') 
`).join(' OR ');

  // BigQuery SQL query
  const query = `
    SELECT * 
    FROM \`gemini-ai-hackathon-v2.BigBasketDataset.products\`
    WHERE ${keywordConditions}
  `;

  try {
    // Run the BigQuery query
    const [rows] = await bigqueryClient.query({ query });

    // Send the search result back
    res.json(rows);
  } catch (err) {
    console.error('Error querying BigQuery:', err);
    res.status(500).json({ error: 'Failed to perform search' });
  }
});


function isProductSuitableForUser(product, userPreferences, geminiKeywords = null) {
  // 1. Filter by Dietary Preferences
  if (userPreferences.dietPreference) {
    if (userPreferences.dietPreference === 'Vegetarian' && !product.is_vegan) {
      return false; // Vegetarians prefer vegan products
    }
    if (userPreferences.dietPreference === 'Vegan' && !product.is_vegan) {
      return false; // Vegan products only
    }
    if (userPreferences.dietPreference === 'Paleo' && product.ingredients.toLowerCase().includes('grains')) {
      return false; // Paleo diet avoids grains
    }
    if (userPreferences.dietPreference === 'Keto' && product.carbohydrates > 10) {
      return false; // Keto diet requires low carbohydrates
    }
    if (userPreferences.dietPreference === 'Gluten-Free' && product.ingredients.toLowerCase().includes('gluten')) {
      return false; // Avoid gluten for gluten-free diets
    }
  }

  // 2. Filter by Allergies
  if (userPreferences.allergies) {
    const allergies = userPreferences.allergies.split(',').map(a => a.trim().toLowerCase());
    for (let allergy of allergies) {
      if (product.ingredients.toLowerCase().includes(allergy)) {
        return false; // Exclude products with any of the listed allergens
      }
    }
  }

  // 3. Filter by Medical Condition
  if (userPreferences.medicalCondition && geminiKeywords?.medicalCondition) {
    // For medical conditions, you might use extracted keywords from Gemini API
    const medicalConditionKeywords = geminiKeywords.medicalCondition;

    if (medicalConditionKeywords.includes('Diabetic') && product.sugar > 5) {
      return false; // Example sugar threshold for diabetic users
    }

    if (medicalConditionKeywords.includes('Hypertension') && product.sodium > 200) {
      return false; // Example sodium threshold for users with hypertension
    }

    if (medicalConditionKeywords.includes('Gluten-Free') && product.ingredients.toLowerCase().includes('gluten')) {
      return false; // Gluten-free medical condition
    }
    //TODO ADD MORE MEDICAL CONDITIONS
  }

  // 4. Filter by Nutritional Goal
  if (userPreferences.nutritionalGoal && geminiKeywords?.nutritionalGoal) {
    const nutritionalGoalKeywords = geminiKeywords.nutritionalGoal;

    if (nutritionalGoalKeywords.includes('Weight loss') && product.calories > 300) {
      return false; // For weight loss, avoid high-calorie products
    }

    if (nutritionalGoalKeywords.includes('Muscle gain') && product.protein < 10) {
      return false; // For muscle gain, products should have sufficient protein content
    }

    // TO DO  Add other goals like "low-carb", "high-fiber", etc., depending on extracted keywords
  }

  // 5. Filter by Environmental Consciousness
  if (userPreferences.environmentallyConscious) {
    if (product.contains_non_recyclable_materials) {
      return false; // Exclude products with non-recyclable packaging or materials
    }

    if (!product.is_eco_friendly) {
      return false; // Exclude products not marked as eco-friendly
    }
  }

  return true; // Product is suitable if none of the preferences are violated
}

// Function to extract keywords using Gemini AI
async function extractKeywordsUsingGemini(userQuery) {
  const prompt = `
    Please extract and return only the most relevant keywords from the following user query: "${userQuery}".
    The keywords should be highly relevant to the context of the query and could include product categories, types, features, or any related synonyms.
    
    Response format: 
    {
      "keywords": ["keyword1", "keyword2", "keyword3"]
    }
    
    Do not include any additional explanations, summaries, or text in the response. Provide only the list of keywords as shown in the format above.
  `;

  try {
    const geminiResponse = await gemini.generateStory(prompt);

    // Clean up the response by removing any Markdown-like formatting (triple backticks, etc.)
    const cleanedResponse = geminiResponse.replace(/```json|```/g, '').trim();

    // Parse the cleaned response to extract keywords
    const parsedResponse = JSON.parse(cleanedResponse);
    const keywords = parsedResponse.keywords || [];

    console.log("Extracted keywords:", keywords);
    return keywords;  // Return the cleaned list of keywords
  } catch (error) {
    console.error('Error extracting keywords from Gemini:', error);
    throw new Error('Keyword extraction failed');
  }
}

async function extractUserPreferencesKeywords(userPreferences) {
  const medicalCondition = userPreferences.medicalCondition && userPreferences.medicalCondition.trim() !== ''
    ? userPreferences.medicalCondition
    : 'No medical conditions provided'; // Default message if empty

  const nutritionalGoal = userPreferences.nutritionalGoal && userPreferences.nutritionalGoal.trim() !== ''
    ? userPreferences.nutritionalGoal
    : 'No nutritional goals provided'; // Default message if empty

  const prompt = `
    Extract meaningful keywords from the following user preferences related to medical conditions and nutritional goals:
    Medical Condition: "${medicalCondition}"
    Nutritional Goal: "${nutritionalGoal}"
    
    Please extract and return relevant keywords for medical conditions (e.g., 'Diabetic', 'Hypertension') and nutritional goals (e.g., 'Weight loss', 'Muscle gain') in a structured format.
  `;

  try {
    const geminiResponse = await gemini.generateStory(prompt);
    console.log("Raw Gemini Response:", geminiResponse);

    // Clean up the response by removing markdown-like content
    const cleanedResponse = geminiResponse
      .replace(/##/g, '') 
      .replace(/\*\*\s*\*\*/g, '') 
      .replace(/\*/g, '') 
      .replace(/Medical Conditions:.*|Nutritional Goals:.*/g, '') 
      .trim(); 

    console.log("Cleaned Gemini Response:", cleanedResponse);

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(cleanedResponse);
    } catch (error) {
      console.error("Failed to parse cleaned response as JSON. Returning raw text:", cleanedResponse);
      return cleanedResponse; // Return the cleaned text if JSON parsing fails
    }

    return parsedResponse; // Return the parsed JSON if successful

  } catch (error) {
    console.error('Error extracting keywords from Gemini:', error);
    throw new Error('Keyword extraction failed');
  }
}

// Generate Keywords API based on user profile
app.post('/generateKeywordsByProfile', express.json(), async (req, res) => {
  const personalInfo = req.body.personalInfo || {};

  if (!personalInfo || Object.keys(personalInfo).length === 0) {
    return res.status(400).json({ error: 'Please provide personal information for generating keywords' });
  }

  try {
    // Generate the prompt for Gemini AI based on the user's personal info
    const prompt = `
    Based on the following user profile information, generate a list of relevant keywords that describe food preferences, snacks, diet categories, and any other related categories.

    Personal Info:
    Diet Preference: ${personalInfo.dietPreference || 'N/A'}
    Allergies: ${personalInfo.allergies || 'N/A'}
    Medical Condition: ${personalInfo.medicalCondition || 'N/A'}
    Nutritional Goal: ${personalInfo.nutritionalGoal || 'N/A'}
    Preferred Products: ${personalInfo.productInterests || 'N/A'}

    The keywords should be highly relevant to the context of search means we use these keywords to search the products in db using like keyword by name and category and could of type product categories, types, features, or any related synonyms.
    Give preference to Preferred Products if any. Also return max of 10 keywords as response.

    Response format: 
    {
      "keywords": ["keyword1", "keyword2", "keyword3"]
    }
    
    Do not include any additional explanations, summaries, or text in the response. Provide only the list of keywords as shown in the format above.
    `;

    // Call the Gemini API to generate keywords
    const geminiResponse = await gemini.generateStory(prompt);

    // Clean up the response and ensure it's in the correct format
    const cleanedResponse = geminiResponse.replace(/```json|```/g, '').trim();
    const parsedKeywords = JSON.parse(cleanedResponse);

    // Send the parsed keywords as the response
    res.json(parsedKeywords);

  } catch (error) {
    console.error('Error generating keywords using Gemini:', error);
    res.status(500).json({ error: 'Failed to generate keywords' });
  }
});

// Recommendations API
app.post('/recommendations', express.json(), async (req, res) => {
  console.log('Incoming request body:', req.body);

  const userQuery = req.body.query;
  let personalInfo = req.body.personalInfo || {};
  console.log('User query:', userQuery);
  console.log('Personal info before parsing:', personalInfo);

  // Check if personalInfo is a string and try to parse it, otherwise use it directly
  if (typeof personalInfo === 'string') {
    try {
      personalInfo = JSON.parse(personalInfo);
      console.log('Parsed personalInfo:', personalInfo);
    } catch (error) {
      console.error('Failed to parse personalInfo JSON:', error);
      return res.status(400).json({ error: 'Invalid JSON format for personalInfo' });
    }
  }

  // Log warnings for empty fields, but do not fail the request
  if (!userQuery) {
    console.error('User query is missing or empty');
    return res.status(400).json({ error: 'Please provide a search query' });
  }

  const requiredFields = ['dietPreference', 'allergies', 'medicalCondition', 'nutritionalGoal'];
  requiredFields.forEach(field => {
    if (!personalInfo[field] || personalInfo[field].trim() === '') {
      console.warn(`Warning: ${field} is missing or empty`);
    }
  });

  try {
    // Step 1: Extract keywords using Gemini AI (for query)
    const keywords = await extractKeywordsUsingGemini(userQuery);
    console.log('Extracted keywords from query:', keywords);

    // Step 2: Extract medical and nutritional keywords from personal info
    const geminiKeywords = await extractUserPreferencesKeywords(personalInfo);
    console.log('Extracted keywords from personal info:', geminiKeywords);

    // Step 3: Query BigQuery for products based on keywords
    await initializeBigQuery();
    console.log('BigQuery initialized');

    const sanitizeKeyword = (keyword) => {
      // Escape single quotes in the keyword to prevent SQL errors
      return keyword.replace(/'/g, "''");
    }

    const keywordConditions = keywords.map(keyword => `
      LOWER(name) LIKE LOWER('%${sanitizeKeyword(keyword)}%') 
      OR LOWER(category) LIKE LOWER('%${sanitizeKeyword(keyword)}%') 
      OR LOWER(ingredients) LIKE LOWER('%${sanitizeKeyword(keyword)}%') 
      OR LOWER(type) LIKE LOWER('%${sanitizeKeyword(keyword)}%') 
      OR LOWER(nutrition) LIKE LOWER('%${sanitizeKeyword(keyword)}%') 
    `).join(' OR ');

    const query = `
      SELECT * 
      FROM \`gemini-ai-hackathon-v2.BigBasketDataset.products\`
      WHERE ${keywordConditions}
    `;

    // Log the generated query for debugging
    console.log('Generated SQL Query:', query);

    const [products] = await bigqueryClient.query({ query });
    console.log('Retrieved products from BigQuery:', products.length);

    // Step 4: Filter products based on user preferences and Gemini-extracted keywords
    const suitableProducts = products.filter(product => isProductSuitableForUser(product, personalInfo, geminiKeywords));
    console.log('Filtered suitable products:', suitableProducts.length);

    // Step 5: Return the filtered product recommendations
    res.json(suitableProducts);
    console.log('Recommendations sent in response');

  } catch (error) {
    console.error('Error processing recommendations request:', error);
    res.status(500).json({ error: 'Failed to process recommendations' });
  }
});

// Endpoint for image analysis and story generation via Gemini AI
app.post("/analyze", upload.single("image"), express.json(), async (req, res) => {
  try {
    const imagePath = req.file.path;

    // Initialize Vision client with credentials from Secret Manager
    const client = await initializeVisionClient();

    const personalInfo = req.body.personalInfo ? JSON.parse(req.body.personalInfo) : {};  // Parse the JSON string
    const preferredLanguage = personalInfo.language || 'English'; 
    console.log("Personal Info preferredLanguage:", preferredLanguage);
    // Call the Google Vision API to extract text from the image
    const [result] = await client.textDetection(imagePath);
  
    let detectedText = result.textAnnotations[0]?.description || ''; // Extract the raw text from the image


    if (!detectedText) {
      // If no text is detected, try label detection as a fallback
      console.log("No text detected. Attempting label detection...");
      const [labelResult] = await client.labelDetection(imagePath);
      const labels = labelResult.labelAnnotations.map(label => label.description);
      
      console.log("Detected Labels:", labels);
  
      if (labels.length > 0) {
        detectedText = `This image contains: ${labels.join(', ')}`;
      } else {
        // If no labels are found, try object localization
        console.log("No labels detected. Attempting object localization...");
        const [objectResult] = await client.objectLocalization(imagePath);
        const objects = objectResult.localizedObjectAnnotations.map(object => object.name);
  
        if (objects.length > 0) {
          detectedText = `Objects detected: ${objects.join(', ')}`;
        } else {
          // If all else fails, try web detection
          console.log("No objects detected. Attempting web detection...");
          const [webResult] = await client.webDetection(imagePath);
          const webEntities = webResult.webDetection.webEntities.map(entity => entity.description);
  
          if (webEntities.length > 0) {
            detectedText = `Web-detected entities: ${webEntities.join(', ')}`;
          } else {
            detectedText = 'No meaningful content could be detected from the image.';
          }
        }
      }
    }
  
    console.log("Final Detected Text or Contextual Labels:", detectedText);

    console.log("Personal Info:", personalInfo);

    // Check if the detected text contains nutritional/ingredient information
    const prompt = `
I have extracted the following text from a product label: "${detectedText}".
Personal information (in JSON format) provided by the user for personalization is as follows:
${JSON.stringify(personalInfo)}

The user prefers the response in **${preferredLanguage}**. Ensure the **entire response is in ${preferredLanguage}** for all the values, while keeping the JSON keys in English.

### Part 1: Raw Nutritional Information with Allowed Value Comparisons (For Food Products)
1. If the text contains nutritional information, extract any raw nutritional details, regardless of the format. This could be presented in tables, bullet points, or unstructured text.
2. Compare the extracted values with standard daily recommended or allowable values (e.g., FDA, WHO, etc.).
3. If the values exceed the recommended limits, indicate this and explain the potential side effects of overconsumption (e.g., high sodium, saturated fat).
4. Provide reference links to sources where the allowed values are derived (e.g., FDA guidelines).
5. If no nutritional information is present or detected, return an empty nutritionalInfo array in the response.

### Part 2: Ingredient Analysis (For Food Products)
1. If ingredients are detected, extract and analyze the ingredient information, even if ingredients are hidden in scientific or chemical names.
2. Convert scientific or uncommon ingredient names into more common equivalents, if possible.
3. For each ingredient, provide detailed nutritional data such as calories, proteins, carbs, fats, and sugars.
4. Identify potential side effects or health risks associated with each ingredient (e.g., allergens, high sugar content), and also consider this personal info to identify any risks specific to the user.
5. Provide reference links to external sources for further reading.
6. If no ingredients are detected, return an empty ingredients array in the response.

### Part 3: Product Metadata and Fallback Strategy (For All Products)
1. Extract any additional metadata like the product title, category, and manufacturer if available in the text.
2. If the product does not contain food-related data (i.e., nutritional or ingredient information), generate suitable metadata based on the text, such as a product title and category (e.g., electronics, cosmetics, apparel).
3. Use the image context or text patterns to infer information such as the type of product, category, and general use case.
4. If no valid nutritional or ingredient data is found, return empty arrays for nutritionalInfo and ingredients and populate productTitle, category, and manufacturer based on the available text or context.
5. Return a message stating that the image contains insufficient nutritional information if the product is not food-related.

### Part 4: Product Summary and Context-Based Recommendation (For All Products)
1. Based on the extracted and analyzed data, generate a summary of the product, considering the personal info provided by the user, including dietary preferences, health conditions, and environmental preferences.
2. If the product is a non-food item, generate a suitable product summary that matches the context of the text or image.
3. For non-food products, provide a recommendation based on its general use, safety, or other relevant features derived from the text. For example, suggest if the product is suitable for daily use, specific activities, or sensitive users (e.g., certain cosmetics, electronics for specific needs).
4. Include key insights about the product, such as its safety, usability, or general characteristics based on the text. These should be relevant to non-food products (e.g., durability, eco-friendliness, materials).
5. Provide an overall assessment of the product’s value, whether it is good for general use, recommended for certain user groups, or should be avoided based on detected risks or personal info.
6. Ingredient Allergy and Sensitivity Detection: Go beyond standard ingredient information. Use AI to analyze ingredient interactions and provide personalized alerts for users with allergies or sensitivities. Identify any potential risks or benefits related to ingredient combinations and suggest safer alternatives if necessary, particularly for users with food allergies, sensitivities, or specific health conditions.
7. Provide a message summarizing the product’s main context or if there is insufficient information available for detailed analysis.


### Expected JSON Structure:
{
  "productTitle": "Product Title (if found else generated suitable one)",
  "category": "Product Category (if inferred else generated suitable one)",
  "manufacturer": "Manufacturer (if found else N/A)",
  "nutritionalInfo": [
    {
      "nutrient": "Nutrient Name",
      "per100g": "Value per 100g or null",
      "perServing": "Value per serving or null",
      "%RDA": "RDA percentage or null",
      "allowedValue": "Allowed value from reputable source",
      "exceedsAllowed": true/false,
      "sideEffects": ["Side effect 1", "Side effect 2"],
      "referenceLinks": ["URL1", "URL2"],
      "otherColumns": {
        "anyColumnName": "any value as it appears in the image"
      }
    }
  ],
  "ingredients": [
    {
      "name": "Ingredient Name",
      "commonName": "Common Ingredient Name (if applicable)",
      "subIngredients": ["Sub-Ingredient 1", "Sub-Ingredient 2"],
      "nutritionalData": {
        "calories": "X kcal",
        "sugar": "Y g",
        "proteins": "Z g",
        "carbs": "A g",
        "fats": "B g"
      },
      "sideEffects": ["Side effect 1", "Side effect 2"],
      "externalSources": ["Source 1", "Source 2"]
    }
  ],
  "summary": {
    "overallAssessment": "Good for consumption / Consume in moderation / Not recommended",
    "keyInsights": [
      "Low in saturated fats, which makes it a healthier choice.",
      "Contains high levels of sodium, which can lead to high blood pressure."
    ],
    "recommendation": "This product is safe for most consumers but should be avoided by those with high blood pressure due to its sodium content.",
    "ingredientAllergyDetection": {
      "hasAllergiesOrSensitivities": true/false,
      "alerts": ["Allergen 1", "Allergen 2"],
      "safeAlternatives": ["Alternative Product 1", "Alternative Product 2"]
    },
    "message": "If no valid nutritional or ingredient data is found, return a message here"
  }
}

Ensure the **values in the JSON** are generated in **${preferredLanguage}**, while the **keys remain in English**. If no language is provided, default to English.
`;

    // Send the prompt to Gemini AI to generate the structured response
    let output;
    try {
      output = await gemini.generateStory(prompt);
    } catch (error) {
      console.error('Error during Gemini AI call:', error);
      res.status(500).send('Error analyzing the data through Gemini AI.');
      return;
    }

    // Log raw output to check format
    console.log("Gemini AI Output:", output);

    // Check if the response contains an "invalid image" message
    if (output.toLowerCase().includes('invalid image')) {
      res.status(400).json({ error: 'Invalid image. No ingredients or nutritional information found.' });
      return;
    }

    // Try to parse the response as JSON
    let jsonResponse;
    try {
      jsonResponse = JSON.parse(output);  // Check if it's valid JSON
    } catch (parseError) {
      console.error("Gemini AI response is not valid JSON:", output);
      res.status(200).send(output); // Send raw text if parsing fails
      return;
    }

    // Send the parsed JSON as the API response
    res.status(200).json(jsonResponse);

  } catch (error) {
    console.error("Error analyzing the image:", error);
    res.status(500).send("Error analyzing the image.");
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
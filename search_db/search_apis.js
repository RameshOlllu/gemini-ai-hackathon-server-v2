const express = require('express');
const router = express.Router();
const {SearchServiceClient} = require('@google-cloud/discoveryengine').v1beta;


const projectId = 'gemini-ai-hackathon-v2';
const location = 'global';              // Options: 'global', 'us', 'eu'
const collectionId = 'default_collection';     // Options: 'default_collection'
const dataStoreId = 'consume-prod-store_1727602874869'       // Create in Cloud Console
const servingConfigId = 'default_search:search';      // Options: 'default_config'

const apiEndpoint =
  location === 'global'
    ? 'discoveryengine.googleapis.com'
    : `${location}-discoveryengine.googleapis.com`;

// Instantiates a client
const client = new SearchServiceClient({apiEndpoint: apiEndpoint});

async function search(searchQuery) {
  // The full resource name of the search engine serving configuration.
  // Example: projects/{projectId}/locations/{location}/collections/{collectionId}/dataStores/{dataStoreId}/servingConfigs/{servingConfigId}
  // You must create a search engine in the Cloud Console first.
  const name = client.projectLocationCollectionDataStoreServingConfigPath(
    projectId,
    location,
    collectionId,
    dataStoreId,
    servingConfigId
  );

  const request = {
    pageSize: 10,
    query: searchQuery,
    servingConfig: name,
  };

  const IResponseParams = {
    ISearchResult: 0,
    ISearchRequest: 1,
    ISearchResponse: 2,
  };

  // Perform search request
  const response = await client.search(request, {
    autoPaginate: false,
  });
  const results = response[IResponseParams.ISearchResponse].results;

  for (const result of results) {
    console.log(result);
  }

  return results;
}

router.get('/', async (req, res)=> {
  try {
    console.log("Mouli Search Started");
    const searchQuery = req.params.searchQuery;
    search(searchQuery);
    res.send(results);
  } catch (error) {
    console.log("Mouli Error");
    res.status(400).send(error);
  }
    
});

module.exports = router;
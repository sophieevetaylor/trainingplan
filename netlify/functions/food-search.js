exports.handler = async function(event) {
  const query = event.queryStringParameters && event.queryStringParameters.q;
  if (!query) {
    return { statusCode: 400, body: JSON.stringify({ error: "No query" }) };
  }

  // Try Open Food Facts first (no key needed, good for Australian products)
  const offUrl = "https://world.openfoodfacts.org/cgi/search.pl"
    + "?search_terms=" + encodeURIComponent(query)
    + "&search_simple=1&action=process&json=1&page_size=12"
    + "&fields=product_name,brands,nutriments,serving_quantity,serving_size";

  try {
    const response = await fetch(offUrl, {
      headers: { "User-Agent": "TrainingPlanApp/1.0" }
    });
    const data = await response.json();

    // Filter to products with valid calorie data
    const products = (data.products || []).filter(p =>
      p.product_name &&
      p.nutriments &&
      (p.nutriments["energy-kcal_100g"] > 0 || p.nutriments["energy-kcal"] > 0)
    );

    if (products.length > 0) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ source: "off", products })
      };
    }
  } catch (err) {
    // Fall through to backup
  }

  // Fallback: USDA FoodData Central
  const usdaKey = "mkz1vuOZoZUlNnU1KhBDX6rHqwbkX97TizE9I4b5";
  const usdaUrl = "https://api.nal.usda.gov/fdc/v1/foods/search?query="
    + encodeURIComponent(query)
    + "&pageSize=12&dataType=Foundation,SR%20Legacy,Survey%20(FNDDS),Branded&api_key="
    + usdaKey;

  try {
    const response = await fetch(usdaUrl);
    const data = await response.json();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ source: "usda", foods: data.foods || [] })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Search failed", detail: err.message })
    };
  }
};

import os
import requests
import pandas as pd
from datetime import datetime
import joblib
from flask import Flask, jsonify, request
from flask_cors import CORS
import google.generativeai as genai

# --- CONFIGURATION ---
MODEL_FOLDER_PATH = "Github/EcoMinder/models_2025-07-01_16-02-31" # <-- PASTE FOLDER NAME HERE

# --- CONSTANTS ---
EXPECTED_FEATURES = [
    'temperature', 'humidity', 'visibility', 'apparentTemperature', 'pressure', 'windSpeed',
    'cloudCover', 'windBearing', 'precipIntensity', 'dewPoint', 'precipProbability',
    'hour', 'day_of_week', 'month'
]

# --- SETUP ---
app = Flask(__name__)
CORS(app)

try:
    GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
    if not GEMINI_API_KEY: raise ValueError("GEMINI_API_KEY environment variable not set.")
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
    print("Gemini AI model configured successfully.")
except Exception as e:
    gemini_model = None
    print(f"Warning: Gemini AI could not be configured: {e}")

# --- HELPER FUNCTIONS (No changes needed here) ---
def get_weather_data(api_params):
    try:
        response = requests.get("https://api.open-meteo.com/v1/forecast", params=api_params)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"API Error: {e}")
        return None

def create_feature_df(weather_df):
    df = weather_df.copy()
    df = df.rename(columns={'time': 'timestamp', 'temperature_2m': 'temperature', 'relative_humidity_2m': 'humidity', 'apparent_temperature': 'apparentTemperature', 'pressure_msl': 'pressure', 'wind_speed_10m': 'windSpeed', 'cloud_cover': 'cloudCover', 'wind_direction_10m': 'windBearing', 'precipitation': 'precipIntensity', 'dew_point_2m': 'dewPoint', 'precipitation_probability': 'precipProbability'})
    df['timestamp'] = pd.to_datetime(df.get('timestamp', pd.Timestamp.now()))
    df['humidity'] = df.get('humidity', 0) / 100.0
    df['cloudCover'] = df.get('cloudCover', 0) / 100.0
    df['hour'] = df['timestamp'].dt.hour
    df['day_of_week'] = df['timestamp'].dt.dayofweek
    df['month'] = df['timestamp'].dt.month
    for col in EXPECTED_FEATURES:
        if col not in df: df[col] = 0
    return df[EXPECTED_FEATURES]

def generate_gemini_suggestion(prompt):
    if not gemini_model: return "AI suggestions are currently unavailable."
    try:
        response = gemini_model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        print(f"Gemini Error: {e}")
        return "Could not generate an AI suggestion at this time."

# --- API ENDPOINTS (CORRECTED) ---

@app.route('/predict', methods=['GET'])
def predict():
    appliance_name = request.args.get('appliance')
    if not appliance_name: return jsonify({'error': 'Appliance name is required.'}), 400

    # FIX: Dynamically create model filename from the appliance name
    sanitized_name = appliance_name.replace(' ', '_').replace('[', '').replace(']', '')
    model_filename = f"{sanitized_name}.joblib"
    model_path = os.path.join(MODEL_FOLDER_PATH, model_filename)
    
    if not os.path.exists(model_path): return jsonify({'error': f"Model file '{model_filename}' not found."}), 404
    
    params = { "latitude": 42.36, "longitude": -71.06, "current": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,pressure_msl,wind_speed_10m,wind_direction_10m,cloud_cover,dew_point_2m,visibility", "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "precipitation_unit": "inch" }
    weather_json = get_weather_data(params)
    if not weather_json: return jsonify({'error': 'Could not retrieve live weather data.'}), 500
        
    features = create_feature_df(pd.DataFrame(weather_json['current'], index=[0]).rename(columns={'time':'timestamp'}))
    model = joblib.load(model_path)
    prediction = model.predict(features)[0]

    response_data = {'appliance': appliance_name, 'predicted_usage_kW': round(prediction, 4), 'weather_inputs': features.iloc[0].to_dict(), 'timestamp_utc': datetime.utcnow().isoformat()}
    return jsonify(response_data)

@app.route('/predict_hourly_forecast', methods=['GET'])
def predict_hourly_forecast():
    appliance_name = request.args.get('appliance')
    if not appliance_name: return jsonify({'error': 'Appliance name is required.'}), 400
    
    # FIX: Dynamically create model filename from the appliance name
    sanitized_name = appliance_name.replace(' ', '_').replace('[', '').replace(']', '')
    model_filename = f"{sanitized_name}.joblib"
    model_path = os.path.join(MODEL_FOLDER_PATH, model_filename)

    if not os.path.exists(model_path): return jsonify({'error': f"Model file '{model_filename}' not found."}), 404
        
    params = { "latitude": 42.36, "longitude": -71.06, "hourly": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,pressure_msl,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,dew_point_2m", "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "precipitation_unit": "inch", "forecast_days": 1 }
    weather_json = get_weather_data(params)
    if not weather_json: return jsonify({'error': 'Could not retrieve forecast data.'}), 500

    forecast_df = pd.DataFrame(weather_json['hourly'])
    renamed_df = forecast_df.rename(columns={'time': 'timestamp', 'temperature_2m': 'temperature'})
    features = create_feature_df(forecast_df)
    model = joblib.load(model_path)
    hourly_predictions = model.predict(features)
    
    avg_temp = renamed_df['temperature'].mean()
    total_predicted_usage = sum(hourly_predictions)
    peak_usage_hour = pd.Series(hourly_predictions).idxmax()
    peak_usage_time = datetime.strptime(str(peak_usage_hour), "%H").strftime("%I %p")
    prompt = f"You are an energy efficiency assistant. Based on this 24-hour predicted usage forecast for a {appliance_name} (Total: {total_predicted_usage:.2f} kWh, Peak Time: {peak_usage_time}, Avg Temp: {avg_temp:.1f}°F), provide one concise, actionable energy-saving tip."
    ai_suggestion = generate_gemini_suggestion(prompt)

    response_data = {
        'forecast': {'hours': [dt.strftime('%I %p') for dt in pd.to_datetime(weather_json['hourly']['time'])], 'predictions': list(hourly_predictions)},
        'suggestion': ai_suggestion
    }
    return jsonify(response_data)

# (The /get_ai_feedback endpoint and main execution block are unchanged)
@app.route('/get_ai_feedback', methods=['POST'])
def get_ai_feedback():
    data = request.get_json()
    if not data or 'appliance' not in data or 'predictedData' not in data or 'actualSensorData' not in data:
        return jsonify({'error': 'Missing data in request'}), 400
    total_predicted = sum(data['predictedData'])
    total_actual = sum(data['actualSensorData'])
    percent_diff = ((total_predicted - total_actual) / total_predicted * 100) if total_predicted > 0 else 0
    prompt = f"You are an energy efficiency assistant analyzing a user's smart sensor data for their {data['appliance']} against the forecast. Total Predicted Usage was {total_predicted:.2f} kWh, but Actual Usage was {total_actual:.2f} kWh ({percent_diff:.1f}% difference). Provide one concise, helpful insight or tip based on this performance."
    feedback = generate_gemini_suggestion(prompt)
    return jsonify({'suggestion': feedback})

if __name__ == '__main__':
    if "YOUR_ACTUAL_MODELS_FOLDER_NAME_HERE" in MODEL_FOLDER_PATH:
        print("FATAL ERROR: Please update the 'MODEL_FOLDER_PATH' variable in the script.")
    else:
        print("Starting Flask server...")
        app.run(debug=False, port=5001)
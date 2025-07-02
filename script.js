// Global state and configuration
const BACKEND_URL = 'http://localhost:5001';
let forecastChart;

/**
 * Main initialization function when the page loads.
 */
document.addEventListener('DOMContentLoaded', () => {
    initializeChart();
    
    const deviceSelector = document.getElementById('device-selector');
    
    // Function to update all data based on the selected device
    const updateDashboardForDevice = () => {
        const selectedDevice = deviceSelector.value;
        const selectedDeviceText = deviceSelector.options[deviceSelector.selectedIndex].text;
        
        console.log(`Updating dashboard for: ${selectedDevice}`);
        
        document.getElementById('prediction-appliance').textContent = selectedDeviceText;
        document.getElementById('main-header-subtitle').textContent = `Predicted usage for ${selectedDeviceText} based on today's hourly weather forecast.`

        updateLivePrediction(selectedDevice);
        updateForecastChart(selectedDevice);
        resetSensorWidgets(); 
    };

    deviceSelector.addEventListener('change', updateDashboardForDevice);

    updateDashboardForDevice(); // Initial load

    // Set up periodic updates for the currently selected device
    setInterval(() => {
        const selectedDevice = document.getElementById('device-selector').value;
        updateLivePrediction(selectedDevice);
    }, 900000); // 15 minutes
});

/**
 * Fetches data from a backend endpoint with query parameters.
 */
async function fetchData(endpoint, options = {}) {
    const url = new URL(`${BACKEND_URL}${endpoint}`);
    if (options.method === 'GET' || !options.method) {
        Object.keys(options.params || {}).forEach(key => url.searchParams.append(key, options.params[key]));
    }

    try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
        return await response.json();
    } catch (error) {
        console.error(`Failed to fetch from ${url}:`, error);
        return null;
    }
}

/**
 * Updates the live prediction widget for a specific device.
 */
async function updateLivePrediction(deviceName) {
    const data = await fetchData('/predict', { params: { appliance: deviceName } });
    if (!data) {
        document.getElementById('prediction-value').textContent = 'Error';
        return;
    }
    document.getElementById('prediction-value').textContent = data.predicted_usage_kW.toFixed(2);
    document.getElementById('last-updated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
}

/**
 * Initializes the Chart.js forecast chart with improved styling.
 */
function initializeChart() {
    const ctx = document.getElementById('forecastChart').getContext('2d');
    forecastChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { weight: '500' } }, grid: { color: 'rgba(255, 255, 255, 0.15)' } },
                x: { ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { weight: '500' } }, grid: { color: 'rgba(255, 255, 255, 0.1)' } }
            },
            plugins: { 
                legend: { labels: { color: 'rgba(255, 255, 255, 0.9)', font: { size: 14 } } },
                annotation: {
                    annotations: {
                        currentTimeLine: {
                            type: 'line', mode: 'vertical', scaleID: 'x', value: new Date().getHours(),
                            borderColor: 'rgba(255, 171, 64, 1)', borderWidth: 2, borderDash: [6, 6],
                            label: { content: 'Current Time', enabled: true, position: 'start', backgroundColor: 'rgba(255, 171, 64, 1)', font: { weight: 'bold' }}
                        }
                    }
                }
            }
        }
    });
}

/**
 * Fetches the hourly forecast and updates the main chart and suggestion box.
 */
async function updateForecastChart(deviceName) {
    const data = await fetchData('/predict_hourly_forecast', { params: { appliance: deviceName } });
    const suggestionTextEl = document.getElementById('suggestion-text');
    
    if (!data || !data.forecast) {
        forecastChart.data.labels = [];
        forecastChart.data.datasets = [];
        forecastChart.update();
        suggestionTextEl.textContent = data.error || "Could not load forecast for this device.";
        return;
    };
    
    const { hours, predictions } = data.forecast;
    
    forecastChart.data.labels = hours;
    forecastChart.data.datasets = [{
        label: `${deviceName.replace(' [kW]', '')} Predicted Usage (kW)`, data: predictions,
        borderColor: 'rgba(77, 123, 255, 1)', backgroundColor: 'rgba(77, 123, 255, 0.2)',
        borderWidth: 3, fill: true, tension: 0.4, pointRadius: 0
    }];
    
    forecastChart.options.plugins.annotation.annotations.currentTimeLine.value = new Date().getHours();
    forecastChart.update();

    if (data.suggestion) {
        suggestionTextEl.textContent = data.suggestion;
    }
}

/**
 * Simulates connecting a smart sensor and fetches personalized feedback.
 */
async function connectSensor() {
    const connectBtn = document.getElementById('connect-sensor-btn');
    if (connectBtn.disabled) return;

    const deviceName = document.getElementById('device-selector').value;
    const predictedData = forecastChart.data.datasets[0].data;

    if (predictedData.length === 0) {
        alert("Please select a device and load a forecast before connecting a sensor.");
        return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'Sensor Connected';
    document.getElementById('sensor-status').textContent = 'Connected';
    document.getElementById('sensor-status').className = 'connected';

    const sensorData = predictedData.map(p => Math.max(0, p + (Math.random() - 0.5) * p * 0.4));

    forecastChart.data.datasets.push({
        label: 'Actual Sensor Usage (kW)', data: sensorData,
        borderColor: 'rgba(29, 233, 182, 1)', borderWidth: 2,
        fill: false, tension: 0.4, pointRadius: 0
    });
    forecastChart.update();

    calculateAndDisplayEfficiency(sensorData, predictedData);
    
    const suggestionTextEl = document.getElementById('suggestion-text');
    suggestionTextEl.textContent = 'Analyzing your performance...';

    const feedbackData = await fetchData('/get_ai_feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appliance: deviceName,
            predictedData: predictedData,
            actualSensorData: sensorData
        })
    });
    
    if (feedbackData && feedbackData.suggestion) {
        suggestionTextEl.textContent = feedbackData.suggestion;
    }
}

/**
 * Analyzes and displays the difference between actual and predicted usage.
 */
function calculateAndDisplayEfficiency(actualData, predictedData) {
    const totalActual = actualData.reduce((sum, val) => sum + val, 0);
    const totalPredicted = predictedData.reduce((sum, val) => sum + val, 0);
    if (totalPredicted === 0) return;

    const percentageDiff = ((totalPredicted - totalActual) / totalPredicted) * 100;
    
    const efficiencyWidget = document.getElementById('efficiency-widget');
    const valueEl = document.getElementById('efficiency-value');
    const textEl = document.getElementById('efficiency-text');

    efficiencyWidget.style.display = 'block';
    
    if (percentageDiff >= 0) {
        valueEl.textContent = `+${percentageDiff.toFixed(1)}%`;
        valueEl.className = 'score-value saved';
        textEl.textContent = "You're using less energy than predicted. Great job!";
    } else {
        valueEl.textContent = `${percentageDiff.toFixed(1)}%`;
        valueEl.className = 'score-value wasted';
        textEl.textContent = "You're using more energy than predicted.";
    }
}

/**
 * Resets the sensor and efficiency widgets when the device changes.
 */
function resetSensorWidgets() {
    document.getElementById('connect-sensor-btn').disabled = false;
    document.getElementById('connect-sensor-btn').textContent = 'Connect Sensor';
    
    const statusEl = document.getElementById('sensor-status');
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'disconnected';
    
    document.getElementById('efficiency-widget').style.display = 'none';
}

// Attach the event listener for the sensor button
document.addEventListener('DOMContentLoaded', () => {
    // This listener was added here to ensure it's attached after the main DOMContentLoaded runs
    document.getElementById('connect-sensor-btn').addEventListener('click', connectSensor);
});
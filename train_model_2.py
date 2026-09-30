import pandas as pd
import joblib
from sklearn.ensemble import IsolationForest

df = pd.read_csv('bess_combined_dataset.csv')

# Define complete 10-feature vector for early-warning detection
FEATURES = [
    'mq8_1', 'mq8_2', 'mq8_1_change', 'mq8_2_change', 'mq8_1_avg_10', 'mq8_2_avg_10',
    'us1_clean_cm', 'us1_swell_mm', 'us1_rate_mm', 'us1_std_10'
]

X = df[FEATURES]

# Train Isolation Forest (contamination=0.03 assumes 3% anomaly threshold)
model = IsolationForest(n_estimators=100, contamination=0.03, random_state=42)
model.fit(X)

# Save model artifact for server.py
joblib.dump(model, 'isolation_forest_bess.joblib')
print("Model successfully trained and saved as 'isolation_forest_bess.joblib'")

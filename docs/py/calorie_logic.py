"""Core nutrition logic shared with Pyodide."""
from __future__ import annotations

STAT_FIELDS = [
    ("calories", "Calories"),
    ("protein", "Protein"),
    ("fat", "Fat"),
    ("fiber", "Fiber"),
    ("carbs", "Carbs"),
]

DEFAULTS = {
    "body_weight": 0.0,
    "weight_unit": "lbs",
    "maintenance_calories": 0.0,
    "caloric_adjustment": 0.0,
    "macro_ratio_unit": "kg",
    "protein_per_unit": 1.8,
    "fat_per_unit": 0.6,
    "fiber_goal": 25.0,
}


def safe_float(value, fallback=0.0):
    if value in (None, ""):
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def convert_weight_to_kg(value, unit):
    value = safe_float(value)
    unit = (unit or "kg").lower()
    if unit == "lbs":
        return value / 2.20462
    return value


def convert_ratio_to_per_kg(value, unit):
    value = safe_float(value)
    unit = (unit or "kg").lower()
    if unit == "lbs":
        return value * 2.20462
    return value


def ratio_for_unit(per_kg_value, unit):
    unit = (unit or "kg").lower()
    if unit == "lbs":
        return per_kg_value / 2.20462
    return per_kg_value


def per_gram_macros(macros, base_grams):
    base = max(safe_float(base_grams), 1e-9)
    per_gram = {}
    for key in ("calories", "protein", "fat", "carbs", "fiber"):
        per_gram[key] = safe_float(macros.get(key)) / base
    return per_gram


def calculate_goals(settings):
    data = {**DEFAULTS, **(settings or {})}
    weight_value = safe_float(data.get("body_weight"))
    weight_unit = data.get("weight_unit", "lbs")
    weight_kg = convert_weight_to_kg(weight_value, weight_unit)

    maintenance = safe_float(data.get("maintenance_calories"))
    adjustment = safe_float(data.get("caloric_adjustment"))
    calories_goal = max(0.0, maintenance + adjustment)

    macro_unit = data.get("macro_ratio_unit", "kg")
    protein_ratio = convert_ratio_to_per_kg(data.get("protein_per_unit"), macro_unit)
    fat_ratio = convert_ratio_to_per_kg(data.get("fat_per_unit"), macro_unit)

    goals = {
        "calories": calories_goal,
        "protein": weight_kg * protein_ratio,
        "fat": weight_kg * fat_ratio,
        "fiber": safe_float(data.get("fiber_goal"), 25.0),
        "carbs": 0.0,
    }
    return goals


def calculate_consumed_totals(entries):
    totals = {key: 0.0 for key, _ in STAT_FIELDS}
    if not entries:
        return totals

    for entry in entries:
        grams = safe_float(entry.get("grams"))
        if grams <= 0:
            continue
        per_gram = entry.get("per_gram", {})
        for key in totals:
            totals[key] += safe_float(per_gram.get(key)) * grams
    return totals


def summarize_item(item):
    name = item.get("name", "Item")
    base = safe_float(item.get("base_grams"))
    calories = safe_float(item.get("macros", {}).get("calories"))
    return f"{name}: {calories:.0f} kcal per {base:.0f} g" if base else name

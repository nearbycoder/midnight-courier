#pragma once

#include "CoreMinimal.h"

DECLARE_LOG_CATEGORY_EXTERN(LogMc, Log, All);

/** One frame of rider input, from the keyboard / gamepad, the autopilot or a test script. */
struct FMcInput
{
	float Throttle = 0.f;   // 0..1 pedal
	float Brake = 0.f;      // 0..1 both brakes
	float Steer = 0.f;      // -1..1 (right positive)
	float Lean = 0.f;       // -1..1 in the air: nose down (+) / nose up (-)
	bool bBrace = false;    // hold: stand on the pedals and soak up hits; release: hop
	bool bDrift = false;    // rear-brake power slide
};

/** What hurt (or nearly hurt) the package. */
enum class EMcShock : uint8
{
	Rattle,     // a wheel bottomed out (stairs, kerbs, potholes)
	Landing,    // the rider's legs bottomed out after air time
	Wall,       // scraped or slammed a wall / obstacle
	Crash,      // went over the bars
	Splash,     // ended up in the canal or the harbour
};

struct FMcShockEvent
{
	EMcShock Type = EMcShock::Rattle;
	float Strength = 0.f;     // m/s of velocity change
	float Damage = 0.f;       // package condition points lost (0..100 scale)
	FVector Location = FVector::ZeroVector;
};

/** A landing that the game wants to grade (shown as a pop-up). */
struct FMcLandingEvent
{
	float AirTime = 0.f;
	float DropHeight = 0.f;   // metres between apex and touchdown
	float ImpactSpeed = 0.f;  // m/s into the ground
	float Damage = 0.f;       // total package damage during the landing window
	bool bPerfect = false;    // braced in the last moment before touchdown
	bool bBraced = false;
	bool bSketchy = false;    // badly misaligned with the ground
};

namespace McUnits
{
	constexpr float M = 100.f; // centimetres per metre
}

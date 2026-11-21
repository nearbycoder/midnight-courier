#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "McWorld.generated.h"

class UStaticMeshComponent;
class UInstancedStaticMeshComponent;
class UMaterialInterface;
class UExponentialHeightFogComponent;
class UPostProcessComponent;
class UDirectionalLightComponent;
class USkyLightComponent;

/** A point on an autopilot / guide route: world position (cm) and target speed (m/s). */
struct FMcRoutePoint
{
	FVector Pos = FVector::ZeroVector;
	float Speed = 10.f;
	bool bBrace = false;      // stand up through this stretch
	bool bHop = false;        // hop when reaching it
};

struct FMcGate
{
	FString Name;
	FVector Pos = FVector::ZeroVector;
	float Yaw = 0.f;
	float Radius = 800.f;
	float HalfWidth = 800.f;
};

/** The neighbourhood: geometry, props, lights, weather, sky. Built from Content/Courier/Data/level.json
 *  (written by the Blender city generator) or, without it, a small physics test course. */
UCLASS()
class AMcWorld : public AActor
{
	GENERATED_BODY()

public:
	AMcWorld();
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	FVector StartPos = FVector(0, 0, 0);
	float StartYaw = 0.f;
	TArray<FMcGate> Checkpoints;     // in order; the last one is the drop-off
	FVector GoalPos = FVector::ZeroVector;
	float GoalYaw = 0.f;
	float GoalRadius = 400.f;
	TMap<FString, TArray<FMcRoutePoint>> Routes;
	TArray<TArray<FVector2D>> MapLines;   // minimap strokes (cm, XY)
	TArray<int32> MapLineKinds;            // 0 road, 1 stairs, 2 alley, 3 water edge, 4 shortcut
	FBox2D MapBounds = FBox2D(ForceInit);
	float WaterZ = -100000.f;
	bool bIsTestCourse = false;

	/** Camera position for the weather to follow. */
	void SetFocus(const FVector& CameraPos, const FVector& Velocity);
	void SetLamp(const FVector& Pos, const FVector& Dir) { LampPos = Pos; LampDir = Dir; }
	/** Pulse of the goal beacon (seconds since the run started). */
	void SetGoalActive(bool bActive);
	void ApplyPostProcess(struct FPostProcessSettings& PP) const;

	UPROPERTY() TObjectPtr<UExponentialHeightFogComponent> Fog;
	UPROPERTY() TObjectPtr<UDirectionalLightComponent> Moon;
	UPROPERTY() TObjectPtr<USkyLightComponent> Sky;

	/** Lightning flash level 0..1 (also used by the HUD/audio for thunder). */
	float Lightning = 0.f;
	bool bThunderPending = false;
	float ThunderDelay = 0.f;
	float NextLightning = 25.f;

protected:
	void BuildTestCourse();
	bool LoadLevel();
	void BuildWeather();
	UStaticMeshComponent* AddMesh(UStaticMesh* Mesh, const FTransform& T, UMaterialInterface* Mat = nullptr, bool bCollide = true);
	UStaticMeshComponent* AddBox(const FVector& Center, const FVector& Size, const FRotator& Rot, UMaterialInterface* Mat);

	UPROPERTY() TObjectPtr<USceneComponent> Root;
	UPROPERTY() TArray<TObjectPtr<UStaticMeshComponent>> Meshes;
	UPROPERTY() TObjectPtr<UInstancedStaticMeshComponent> Rain;
	UPROPERTY() TObjectPtr<UInstancedStaticMeshComponent> Splashes;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> SkyDome;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> Beacon;
	UPROPERTY() TArray<TObjectPtr<UMaterialInterface>> KeepAlive;
	FVector Focus = FVector::ZeroVector;
	FVector FocusVel = FVector::ZeroVector;
	FVector LampPos = FVector::ZeroVector, LampDir = FVector::ForwardVector;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> RainMID;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> SkyMID;
	bool bGoalActive = true;
};

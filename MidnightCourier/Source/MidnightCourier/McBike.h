#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "McTypes.h"
#include "McBike.generated.h"

class UCameraComponent;
class UStaticMeshComponent;
class USpotLightComponent;
class UPointLightComponent;
class UStaticMesh;
class UMaterialInterface;

/**
 * The courier's bike. Physics is hand-rolled (no Chaos): a rigid body in the vertical plane (height + pitch)
 * riding on two sphere-swept wheels with spring/damper suspension and bottom-out impulses, an arcade grip
 * model on the ground plane, and a second spring for the rider's legs that carries the package on their back.
 * Everything runs at a fixed 240 Hz in metres; the world sees centimetres.
 */
UCLASS()
class AMcBike : public APawn
{
	GENERATED_BODY()

public:
	AMcBike();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	/** Puts the bike on the ground at a world position (cm) facing Yaw (degrees), rolling at Speed (m/s). */
	void ResetTo(const FVector& WorldPos, float YawDeg, float Speed = 0.f);

	/** When frozen the bike ignores input and gravity (countdown, results screen). */
	void SetFrozen(bool bInFrozen) { bFrozen = bInFrozen; }
	bool IsFrozen() const { return bFrozen; }

	/** Input for this frame; the game mode writes it before the bike ticks. */
	FMcInput Input;

	// ---- read-outs ------------------------------------------------------------------------------------
	float GetSpeed() const { return FMath::Sqrt(VelXY.SizeSquared() + Vz * Vz); }    // m/s
	float GetForwardSpeed() const;
	FVector GetWorldLocation() const { return FVector(PosXY.X, PosXY.Y, PosZ) * McUnits::M; }
	FVector GetWorldVelocity() const { return FVector(VelXY.X, VelXY.Y, Vz) * McUnits::M; }
	float GetYawDeg() const { return FMath::RadiansToDegrees(Yaw); }
	float GetPitchDeg() const { return FMath::RadiansToDegrees(Pitch); }
	float GetLeanDeg() const { return FMath::RadiansToDegrees(Lean); }
	bool IsGrounded() const { return bGrounded; }
	float GetAirTime() const { return AirTime; }
	bool IsCrashed() const { return bCrashed; }
	float GetCrashTime() const { return CrashTime; }
	bool IsBraced() const { return bBraced; }
	bool IsDrifting() const { return bDriftActive; }
	float GetSlip() const { return SlipAmount; }               // 0..1 how sideways the tyres are
	float GetPackageG() const { return PackageG; }             // felt g on the package (1 at rest)
	float GetShake() const { return Shake; }                   // 0..1 recent shock level
	float GetCondition() const { return Condition; }
	void SetCondition(float C) { Condition = C; }
	float GetWheelSpin() const { return WheelAngle; }
	float GetSurfaceRoll() const { return RollAmount; }        // 0..1 rolling on ground at speed
	FTransform GetBodyTransform() const;                       // world transform of the frame
	FVector GetPackageWorldLocation() const;
	FVector GetHeadLampLocation() const;
	FVector GetHeadLampDirection() const;

	/** Shock / landing events since the last call (the game mode drains them every frame). */
	TArray<FMcShockEvent> PendingShocks;
	TArray<FMcLandingEvent> PendingLandings;
	bool bJustHopped = false;
	bool bJustTookOff = false;

	/** Camera (owned here so it can sweep against the world). */
	UPROPERTY(VisibleAnywhere) TObjectPtr<UCameraComponent> Camera;
	void SnapCamera();
	/** When set, the camera uses this transform (title orbit, results, tests) instead of the chase cam. */
	bool bCameraOverride = false;
	FVector OverrideLoc;
	FRotator OverrideRot;
	float OverrideFov = 60.f;

	/** Visual tint for a ghost copy. */
	void MakeGhost(UMaterialInterface* GhostMat);
	bool bGhost = false;
	void SetPoseFromRecording(const FVector& Loc, const FRotator& Rot, float Crank, float WheelSpin, float Crouch);

	/** Debug / test: force the package to be indestructible. */
	static bool bInvincible;
	/** Water volumes: XY box (cm) and surface height (cm). Below the surface inside a box = splash. */
	struct FWater { FBox2D Area; float Z; };
	static TArray<FWater> Water;

protected:
	void Step(float Dt);
	void StepCrash(float Dt);
	void UpdateVisuals(float Dt);
	void UpdateRider(float Dt);
	void UpdateCamera(float Dt);
	void AddShock(EMcShock Type, float Strength, float Damage);
	void Crash(const TCHAR* Why);

	bool ProbeWheel(const FVector2D& HubXY, float HubZ, float& OutGroundHub, FVector& OutNormal) const;
	bool SweepBody(const FVector& From, const FVector& To, FHitResult& Hit) const;

	// ---- physics state (metres, radians) ---------------------------------------------------------------
	FVector2D PosXY = FVector2D::ZeroVector;   // body centre (between the hubs), horizontal
	float PosZ = 0.f;                          // body centre height
	FVector2D VelXY = FVector2D::ZeroVector;
	float Vz = 0.f;
	float Yaw = 0.f, YawRate = 0.f;
	float Pitch = 0.f, PitchRate = 0.f;
	float Lean = 0.f;
	float SteerSmooth = 0.f;

	// suspension
	float Compression[2] = { 0.f, 0.f };       // front, rear (metres; <=0 off the ground)
	float GroundPrev[2] = { 0.f, 0.f };
	bool bContactPrev[2] = { false, false };
	bool bContact[2] = { false, false };
	FVector GroundNormal[2];
	float StrikeTimer[2] = { 0.f, 0.f };
	float StrikePeak[2] = { 0.f, 0.f };

	// rider legs carrying the package
	float TorsoU = 0.f, TorsoV = 0.f;          // offset from seated rest, metres / m/s
	float BraceHold = 0.f;                     // seconds the brace button has been held
	float BraceReleasedAgo = 10.f;
	float BracePressedAgo = 10.f;
	bool bBraced = false;
	bool bBracePrev = false;
	float PackageG = 1.f;
	float PackageWobble[2] = { 0.f, 0.f };     // visual tilt of the box (pitch, roll) and their rates
	float PackageWobbleV[2] = { 0.f, 0.f };
	float PackageBounce = 0.f, PackageBounceV = 0.f;

	float Condition = 100.f;
	bool bGrounded = false;
	float AirTime = 0.f;
	float GroundTime = 0.f;
	float AirApexZ = 0.f;
	float LandingWindow = 0.f;                 // seconds left in which shocks count toward the landing
	FMcLandingEvent PendingLanding;
	bool bLandingOpen = false;
	bool bDriftActive = false;
	float SlipAmount = 0.f;
	float RollAmount = 0.f;
	float Shake = 0.f;
	float WheelAngle = 0.f;
	float CrankAngle = 0.f;
	float WheelieAmount = 0.f;
	float Accumulator = 0.f;

	bool bFrozen = true;
	bool bCrashed = false;
	float CrashTime = 0.f;
	FVector CrashVel;
	FVector CrashSpin;
	FQuat CrashRot;
	FVector CrashPos;
	FVector PackageFlyPos, PackageFlyVel;
	FQuat PackageFlyRot;
	FVector PackageFlySpin;

	// camera smoothing
	FVector CamPos = FVector::ZeroVector;
	float CamYaw = 0.f, CamPitch = -10.f, CamFov = 80.f, CamDist = 420.f;
	bool bCamInit = false;
	float LookAheadYaw = 0.f;

	// ---- visuals ---------------------------------------------------------------------------------------
	UPROPERTY() TObjectPtr<USceneComponent> Root;
	UPROPERTY() TObjectPtr<USceneComponent> Frame;      // follows the body transform
	UPROPERTY() TArray<TObjectPtr<UStaticMeshComponent>> Parts;
	UStaticMeshComponent* AddPart(FName Name, const TCHAR* MeshName, USceneComponent* Parent, const FLinearColor& Fallback);
	UStaticMeshComponent* Part(FName Name) const;
	TMap<FName, TObjectPtr<UStaticMeshComponent>> PartMap;
	UPROPERTY() TObjectPtr<class UPoseableMeshComponent> RiderMesh;
	struct FRiderBone { FName Name; int32 Index = INDEX_NONE; FTransform RestCS; };
	TMap<FName, FRiderBone> RiderBones;
	void SetupRiderMesh();
	void PoseBone(FName Bone, const FVector& Joint, const FVector& Dir, const FVector& Up, const FVector& RestDir, const FVector& RestUp, bool bUseXY = false);
	UPROPERTY() TObjectPtr<USpotLightComponent> HeadLight;
	UPROPERTY() TObjectPtr<USpotLightComponent> TailLight;
	UPROPERTY() TObjectPtr<UPointLightComponent> FillLight;
	float StandBlend = 0.f;
	// Wheel spray: a small pool of camera-facing mist puffs.
	struct FPuff { FVector Pos; FVector Vel; float Age = 10.f; float Life = 0.5f; float Size = 30.f; };
	TArray<FPuff> Puffs;
	UPROPERTY() TArray<TObjectPtr<UStaticMeshComponent>> PuffMeshes;
	UPROPERTY() TArray<TObjectPtr<class UMaterialInstanceDynamic>> PuffMIDs;
	float SprayAccum = 0.f;
	int32 NextPuff = 0;
	void UpdateSpray(float Dt);
	float RecordedCrouch = 0.f;
	bool bUseRecordedPose = false;
};

#include "McBike.h"

#include "Camera/CameraComponent.h"
#include "Components/PointLightComponent.h"
#include "Components/PoseableMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "ReferenceSkeleton.h"
#include "Components/SpotLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "McAssets.h"
#include "McSettings.h"

bool AMcBike::bInvincible = false;
TArray<AMcBike::FWater> AMcBike::Water;

// =====================================================================================================
// Tuning. Units: metres, seconds, radians. Accelerations are per unit mass (the bike+rider weighs "1").
// =====================================================================================================
namespace Tune
{
	constexpr float G = 9.81f;
	constexpr float StepHz = 240.f;

	// geometry
	constexpr float HalfBase = 0.525f;      // half wheelbase
	constexpr float WheelR = 0.34f;
	constexpr float ProbeR = 0.22f;         // sphere used to feel the ground (rounds off step edges like a tyre)
	constexpr float Ext = 0.11f;            // suspension length from full extension to the body's mount
	constexpr float MaxComp = 0.11f;        // fork + tyre travel
	constexpr float EdgeLift = 1.3f;        // most upward speed a sharp edge can hand the body (m/s)
	constexpr float Sag = 0.035f;

	// suspension (per wheel)
	constexpr float K = 140.f;
	constexpr float C = 7.5f;
	constexpr float PitchInertia = HalfBase * HalfBase * 0.85f;

	// rider legs (the package rides on the rider's back)
	constexpr float SeatK = 240.f, SeatC = 18.f, SeatMin = -0.19f, SeatMax = 0.10f, SeatCap = 3.9f * G;
	constexpr float BraceK = 80.f, BraceC = 10.f, BraceMin = -0.30f, BraceMax = 0.16f, BraceCap = 4.2f * G;

	// drive
	constexpr float Power = 12.f;          // W/kg-ish: accel = Power / speed
	constexpr float PedalAccelMax = 3.6f;
	constexpr float CadenceFull = 12.5f, CadenceZero = 16.5f;
	constexpr float BrakeDecel = 7.5f;
	constexpr float RollRes = 0.05f;
	constexpr float Drag = 0.0042f;
	constexpr float DriftDecel = 1.6f;

	// steering
	constexpr float MinRadius = 1.9f;       // tightest turn at walking pace
	constexpr float LeanTurn = 9.5f;        // yaw-rate * speed limit from leaning
	constexpr float Grip = 16.f, DriftGrip = 2.0f;

	// damage
	constexpr float RattleThreshold = 0.5f, RattleScale = 0.6f, RattleExp = 1.3f;
	constexpr float LegThreshold = 0.8f, LegScale = 2.2f, LegExp = 1.2f;
	constexpr float WallThreshold = 1.6f, WallScale = 1.5f, WallExp = 1.5f;
	constexpr float GSafe = 2.7f, GScale = 1.1f, GExp = 1.7f;
	constexpr float CrashDamage = 22.f;
	constexpr float CrashWallSpeed = 8.5f;
	constexpr float PerfectWindow = 0.40f;  // brace this close to touchdown for a perfect landing
	constexpr float PerfectScale = 0.2f;
}

namespace
{
	FVector2D Dir2(float A) { return FVector2D(FMath::Cos(A), FMath::Sin(A)); }
	FVector2D Right2(float A) { return FVector2D(-FMath::Sin(A), FMath::Cos(A)); }

	/** Two-bone IK in a plane given by a hint direction. Returns the middle joint. */
	FVector SolveIK(const FVector& A, const FVector& Target, float L1, float L2, const FVector& Hint)
	{
		FVector D = Target - A;
		float Dist = D.Size();
		const float MaxReach = (L1 + L2) * 0.999f;
		const float MinReach = FMath::Abs(L1 - L2) + 0.01f;
		Dist = FMath::Clamp(Dist, MinReach, MaxReach);
		const FVector Dir = D.GetSafeNormal();
		const float CosA = FMath::Clamp((L1 * L1 + Dist * Dist - L2 * L2) / (2.f * L1 * Dist), -1.f, 1.f);
		const float SinA = FMath::Sqrt(1.f - CosA * CosA);
		FVector Perp = Hint - Dir * FVector::DotProduct(Hint, Dir);
		Perp = Perp.GetSafeNormal();
		if (Perp.IsNearlyZero()) { Perp = FVector::UpVector; }
		return A + Dir * (CosA * L1) + Perp * (SinA * L1);
	}

	/** Rotation whose X axis points along Dir and whose Z axis is as close as possible to Up. */
	FRotator Along(const FVector& Dir, const FVector& Up)
	{
		return FRotationMatrix::MakeFromXZ(Dir, Up).Rotator();
	}
}

AMcBike::AMcBike()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PrePhysics;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	SetRootComponent(Root);
	Frame = CreateDefaultSubobject<USceneComponent>(TEXT("Frame"));
	Frame->SetupAttachment(Root);

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Root);
	Camera->SetUsingAbsoluteLocation(true);
	Camera->SetUsingAbsoluteRotation(true);
	Camera->bConstrainAspectRatio = false;
	Camera->FieldOfView = 80.f;

	HeadLight = CreateDefaultSubobject<USpotLightComponent>(TEXT("HeadLight"));
	HeadLight->SetupAttachment(Frame);
	HeadLight->SetRelativeLocation(FVector(58.f, 0.f, 40.f));
	HeadLight->SetRelativeRotation(FRotator(-9.f, 0.f, 0.f));
	HeadLight->SetIntensityUnits(ELightUnits::Candelas);
	HeadLight->SetIntensity(5200.f);
	HeadLight->SetLightColor(FLinearColor(1.f, 0.93f, 0.82f));
	HeadLight->SetAttenuationRadius(4200.f);
	HeadLight->SetInnerConeAngle(9.f);
	HeadLight->SetOuterConeAngle(24.f);
	HeadLight->SetSourceRadius(3.f);
	HeadLight->SetCastShadows(true);
	HeadLight->SetVolumetricScatteringIntensity(1.6f);

	TailLight = CreateDefaultSubobject<USpotLightComponent>(TEXT("TailLight"));
	TailLight->SetupAttachment(Frame);
	TailLight->SetRelativeLocation(FVector(-64.f, 0.f, 30.f));
	TailLight->SetRelativeRotation(FRotator(-25.f, 180.f, 0.f));
	Cast<USpotLightComponent>(TailLight)->SetOuterConeAngle(55.f);
	TailLight->SetIntensityUnits(ELightUnits::Candelas);
	TailLight->SetIntensity(6.f);
	TailLight->SetLightColor(FLinearColor(1.f, 0.05f, 0.03f));
	TailLight->SetAttenuationRadius(400.f);
	TailLight->SetCastShadows(false);

	// A soft light that rides with the courier so the rider reads against the dark.
	FillLight = CreateDefaultSubobject<UPointLightComponent>(TEXT("FillLight"));
	FillLight->SetupAttachment(Frame);
	FillLight->SetRelativeLocation(FVector(-160.f, 60.f, 190.f));
	FillLight->SetIntensityUnits(ELightUnits::Candelas);
	FillLight->SetIntensity(2.5f);
	FillLight->SetLightColor(FLinearColor(0.55f, 0.7f, 1.f));
	FillLight->SetAttenuationRadius(420.f);
	FillLight->SetCastShadows(false);
	FillLight->SetSpecularScale(0.3f);
}

UStaticMeshComponent* AMcBike::AddPart(FName Name, const TCHAR* MeshName, USceneComponent* Parent, const FLinearColor& Fallback)
{
	UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this, FName(*(TEXT("Part_") + Name.ToString())));
	C->SetupAttachment(Parent);
	C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	C->SetGenerateOverlapEvents(false);
	C->bCastDynamicShadow = true;
	C->SetCanEverAffectNavigation(false);
	if (UStaticMesh* Mesh = McAssets::Mesh(MeshName))
	{
		C->SetStaticMesh(Mesh);
	}
	else
	{
		C->SetStaticMesh(McAssets::Mesh(TEXT("Cube")));
		C->SetMaterial(0, McAssets::Tinted(this, Fallback));
		C->SetRelativeScale3D(FVector(0.1f));
	}
	C->RegisterComponent();
	Parts.Add(C);
	PartMap.Add(Name, C);
	return C;
}

UStaticMeshComponent* AMcBike::Part(FName Name) const
{
	const TObjectPtr<UStaticMeshComponent>* P = PartMap.Find(Name);
	return P ? P->Get() : nullptr;
}

void AMcBike::BeginPlay()
{
	Super::BeginPlay();

	const FLinearColor Steel(0.1f, 0.1f, 0.11f), Jacket(0.85f, 0.32f, 0.05f), Dark(0.03f, 0.03f, 0.035f), Card(0.55f, 0.38f, 0.2f);
	AddPart("Frame", TEXT("SM_BikeFrame"), Frame, Steel);
	AddPart("Fork", TEXT("SM_BikeFork"), Frame, Steel);
	AddPart("WheelF", TEXT("SM_BikeWheel"), Frame, Dark);
	AddPart("WheelR", TEXT("SM_BikeWheel"), Frame, Dark);
	AddPart("Crank", TEXT("SM_BikeCrank"), Frame, Steel);
	AddPart("PedalL", TEXT("SM_BikePedal"), Frame, Dark);
	AddPart("PedalR", TEXT("SM_BikePedal"), Frame, Dark);
	SetupRiderMesh();
	if (!RiderMesh)
	{
		// Fallback: the rigid-part rider.
		AddPart("Pelvis", TEXT("SM_RiderPelvis"), Frame, Dark);
		AddPart("Torso", TEXT("SM_RiderTorso"), Frame, Jacket);
		AddPart("Head", TEXT("SM_RiderHead"), Frame, Dark);
		AddPart("ThighL", TEXT("SM_RiderThigh"), Frame, Dark);
		AddPart("ThighR", TEXT("SM_RiderThigh"), Frame, Dark);
		AddPart("ShinL", TEXT("SM_RiderShin"), Frame, Dark);
		AddPart("ShinR", TEXT("SM_RiderShin"), Frame, Dark);
		AddPart("FootL", TEXT("SM_RiderFoot"), Frame, Dark);
		AddPart("FootR", TEXT("SM_RiderFoot"), Frame, Dark);
		AddPart("UpperArmL", TEXT("SM_RiderUpperArm"), Frame, Jacket);
		AddPart("UpperArmR", TEXT("SM_RiderUpperArm"), Frame, Jacket);
		AddPart("ForeArmL", TEXT("SM_RiderForeArm"), Frame, Jacket);
		AddPart("ForeArmR", TEXT("SM_RiderForeArm"), Frame, Jacket);
	}
	AddPart("Pack", TEXT("SM_Package"), Frame, Card);

	// Placeholder proportions when the art has not been imported yet.
	if (!McAssets::Mesh(TEXT("SM_BikeFrame")))
	{
		Part("Frame")->SetRelativeScale3D(FVector(1.0f, 0.06f, 0.08f));
		Part("WheelF")->SetRelativeScale3D(FVector(0.68f, 0.05f, 0.68f));
		Part("WheelR")->SetRelativeScale3D(FVector(0.68f, 0.05f, 0.68f));
		Part("Torso")->SetRelativeScale3D(FVector(0.5f, 0.3f, 0.2f));
		Part("Pack")->SetRelativeScale3D(FVector(0.32f, 0.36f, 0.32f));
		Part("Head")->SetRelativeScale3D(FVector(0.22f));
		for (FName N : { FName("ThighL"), FName("ThighR"), FName("ShinL"), FName("ShinR") }) { Part(N)->SetRelativeScale3D(FVector(0.44f, 0.09f, 0.09f)); }
		for (FName N : { FName("UpperArmL"), FName("UpperArmR"), FName("ForeArmL"), FName("ForeArmR") }) { Part(N)->SetRelativeScale3D(FVector(0.28f, 0.07f, 0.07f)); }
	}
	if (bGhost) { HeadLight->SetVisibility(false); TailLight->SetVisibility(false); FillLight->SetVisibility(false); return; }

	if (UMaterialInterface* SprayMat = McAssets::Material(TEXT("M_Spray")))
	{
		for (int32 i = 0; i < 28; ++i)
		{
			UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this);
			C->SetupAttachment(Root);
			C->SetUsingAbsoluteLocation(true);
			C->SetUsingAbsoluteRotation(true);
			C->SetUsingAbsoluteScale(true);
			C->SetStaticMesh(McAssets::Mesh(TEXT("Plane")));
			UMaterialInstanceDynamic* MID = UMaterialInstanceDynamic::Create(SprayMat, this);
			C->SetMaterial(0, MID);
			C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			C->SetCastShadow(false);
			C->SetVisibility(false);
			C->RegisterComponent();
			PuffMeshes.Add(C);
			PuffMIDs.Add(MID);
			Puffs.AddDefaulted();
		}
	}
}

void AMcBike::UpdateSpray(float Dt)
{
	if (PuffMeshes.Num() == 0) { return; }
	const float Speed = GetSpeed();
	// Emit from both tyres when rolling fast on the wet ground, more when sliding.
	const float Rate = (bGrounded && !bCrashed && !bFrozen) ? FMath::Clamp((Speed - 3.f) * 3.5f, 0.f, 45.f) * (1.f + SlipAmount * 2.f) : 0.f;
	SprayAccum += Rate * Dt;
	const FTransform T = Frame->GetComponentTransform();
	while (SprayAccum >= 1.f)
	{
		SprayAccum -= 1.f;
		FPuff& P = Puffs[NextPuff];
		NextPuff = (NextPuff + 1) % Puffs.Num();
		const bool bRear = FMath::FRand() < 0.7f;
		const FVector Local((bRear ? -1.f : 1.f) * Tune::HalfBase * McUnits::M - 20.f, FMath::FRandRange(-6.f, 6.f), -Tune::WheelR * McUnits::M + 8.f);
		P.Pos = T.TransformPosition(Local);
		const FVector Fwd = T.GetUnitAxis(EAxis::X);
		P.Vel = GetWorldVelocity() * 0.35f - Fwd * FMath::FRandRange(80.f, 220.f) + FVector(FMath::FRandRange(-60.f, 60.f), FMath::FRandRange(-60.f, 60.f), FMath::FRandRange(80.f, 220.f));
		P.Age = 0.f;
		P.Life = FMath::FRandRange(0.35f, 0.7f);
		P.Size = FMath::FRandRange(18.f, 34.f) * (0.6f + 0.4f * FMath::Clamp(Speed / 12.f, 0.f, 1.5f));
	}
	const FVector Cam = Camera->GetComponentLocation();
	for (int32 i = 0; i < Puffs.Num(); ++i)
	{
		FPuff& P = Puffs[i];
		P.Age += Dt;
		const bool bAlive = P.Age < P.Life;
		PuffMeshes[i]->SetVisibility(bAlive);
		if (!bAlive) { continue; }
		P.Vel.Z -= 600.f * Dt;
		P.Vel *= FMath::Exp(-3.f * Dt);
		P.Pos += P.Vel * Dt;
		const float F = P.Age / P.Life;
		const float Sz = P.Size * (1.f + F * 2.2f) / 100.f;
		// The engine plane faces +Z; turn it to face the camera.
		const FRotator Face = FRotationMatrix::MakeFromZ(Cam - P.Pos).Rotator();
		PuffMeshes[i]->SetWorldLocationAndRotation(P.Pos, Face);
		PuffMeshes[i]->SetWorldScale3D(FVector(Sz));
		PuffMIDs[i]->SetScalarParameterValue(TEXT("Opacity"), 0.22f * (1.f - F) * FMath::Clamp(F * 8.f, 0.f, 1.f));
	}
}

void AMcBike::SetupRiderMesh()
{
	USkeletalMesh* Mesh = McAssets::SkeletalMesh(TEXT("SK_Rider"));
	if (!Mesh || FParse::Param(FCommandLine::Get(), TEXT("McRigidRider"))) { return; }
	RiderMesh = NewObject<UPoseableMeshComponent>(this, TEXT("RiderMesh"));
	RiderMesh->SetupAttachment(Frame);
	RiderMesh->SetSkinnedAssetAndUpdate(Mesh, true);
	RiderMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	RiderMesh->bCastDynamicShadow = true;
	RiderMesh->SetBoundsScale(1.5f);
	RiderMesh->RegisterComponent();
	// Reference pose in component space.
	const FReferenceSkeleton& Ref = Mesh->GetRefSkeleton();
	const TArray<FTransform>& Local = Ref.GetRefBonePose();
	TArray<FTransform> CS;
	CS.SetNum(Local.Num());
	for (int32 i = 0; i < Local.Num(); ++i)
	{
		const int32 P = Ref.GetParentIndex(i);
		CS[i] = P == INDEX_NONE ? Local[i] : Local[i] * CS[P];
		FRiderBone B;
		B.Name = Ref.GetBoneName(i);
		B.Index = i;
		B.RestCS = CS[i];
		RiderBones.Add(B.Name, B);
		UE_LOG(LogMc, Display, TEXT("MC_BONE %s rest=%s rot=%s scale=%s"), *B.Name.ToString(), *CS[i].GetLocation().ToString(), *CS[i].Rotator().ToString(), *CS[i].GetScale3D().ToString());
	}
}

void AMcBike::PoseBone(FName Bone, const FVector& Joint, const FVector& Dir, const FVector& Up, const FVector& RestDir, const FVector& RestUp, bool bUseXY)
{
	const FRiderBone* B = RiderBones.Find(Bone);
	if (!B || !RiderMesh) { return; }
	const FQuat NewF = bUseXY ? FRotationMatrix::MakeFromXY(Dir, Up).ToQuat() : FRotationMatrix::MakeFromXZ(Dir, Up).ToQuat();
	const FQuat RestF = bUseXY ? FRotationMatrix::MakeFromXY(RestDir, RestUp).ToQuat() : FRotationMatrix::MakeFromXZ(RestDir, RestUp).ToQuat();
	FQuat Rot = (NewF * RestF.Inverse()) * B->RestCS.GetRotation();
	if (Rot.ContainsNaN()) { Rot = B->RestCS.GetRotation(); }
	static bool bLogged = false;
	if (!bLogged) { bLogged = true; UE_LOG(LogMc, Display, TEXT("MC_POSE %s joint=%s rot=%s"), *Bone.ToString(), *Joint.ToString(), *Rot.Rotator().ToString()); }
	RiderMesh->SetBoneTransformByName(Bone, FTransform(Rot, Joint, B->RestCS.GetScale3D()), EBoneSpaces::ComponentSpace);
}

void AMcBike::MakeGhost(UMaterialInterface* GhostMat)
{
	bGhost = true;
	for (UStaticMeshComponent* C : Parts)
	{
		if (!C) { continue; }
		for (int32 i = 0; i < C->GetNumMaterials(); ++i) { C->SetMaterial(i, GhostMat); }
		C->SetCastShadow(false);
		C->bRenderInMainPass = true;
	}
	if (RiderMesh)
	{
		for (int32 i = 0; i < RiderMesh->GetNumMaterials(); ++i) { RiderMesh->SetMaterial(i, GhostMat); }
		RiderMesh->SetCastShadow(false);
	}
	HeadLight->SetVisibility(false);
	TailLight->SetVisibility(false);
	FillLight->SetVisibility(false);
	Camera->Deactivate();
	bFrozen = true;
}

float AMcBike::GetForwardSpeed() const
{
	return FVector2D::DotProduct(VelXY, Dir2(Yaw));
}

void AMcBike::ResetTo(const FVector& WorldPos, float YawDeg, float Speed)
{
	Yaw = FMath::DegreesToRadians(YawDeg);
	YawRate = 0.f;
	PosXY = FVector2D(WorldPos.X, WorldPos.Y) / McUnits::M;
	PosZ = WorldPos.Z / McUnits::M + 1.0f;
	{
		// Find the ground under the spawn point (it may be given roughly).
		FHitResult Hit;
		FCollisionQueryParams Params(SCENE_QUERY_STAT(McSpawn), true, this);
		if (GetWorld()->LineTraceSingleByChannel(Hit, WorldPos + FVector(0, 0, 400.f), WorldPos - FVector(0, 0, 3000.f), ECC_WorldStatic, Params))
		{
			PosZ = Hit.Location.Z / McUnits::M + 0.6f;
		}
	}
	VelXY = Dir2(Yaw) * Speed;
	Vz = 0.f;
	Pitch = 0.f;
	PitchRate = 0.f;
	Lean = 0.f;
	SteerSmooth = 0.f;
	TorsoU = 0.f; TorsoV = 0.f;
	bBraced = false; bBracePrev = false; BraceHold = 0.f;
	bCrashed = false; CrashTime = 0.f;
	AirTime = 0.f; GroundTime = 0.f;
	bLandingOpen = false;
	PendingShocks.Reset();
	PendingLandings.Reset();
	Shake = 0.f;
	PackageWobble[0] = PackageWobble[1] = PackageWobbleV[0] = PackageWobbleV[1] = 0.f;
	for (int32 i = 0; i < 2; ++i) { bContactPrev[i] = false; Compression[i] = 0.f; }

	// Drop onto the ground: find the surface under each wheel and sit at sag.
	float Hubs[2]; FVector N;
	for (int32 i = 0; i < 2; ++i)
	{
		const float Arm = (i == 0 ? 1.f : -1.f) * Tune::HalfBase;
		const FVector2D HubXY = PosXY + Dir2(Yaw) * Arm;
		if (!ProbeWheel(HubXY, PosZ, Hubs[i], N)) { Hubs[i] = PosZ - 0.6f + Tune::WheelR; }
		GroundPrev[i] = Hubs[i];
	}
	Pitch = FMath::Atan2(Hubs[0] - Hubs[1], 2.f * Tune::HalfBase);
	PosZ = 0.5f * (Hubs[0] + Hubs[1]) + Tune::Ext - Tune::Sag;
	bGrounded = true;
	bCamInit = false;
	SetActorHiddenInGame(false);
	UpdateVisuals(0.f);
}

bool AMcBike::ProbeWheel(const FVector2D& HubXY, float HubZ, float& OutGroundHub, FVector& OutNormal) const
{
	const float Up = 0.55f, Down = Tune::Ext + 0.45f;
	const FVector Start = FVector(HubXY.X, HubXY.Y, HubZ + Up) * McUnits::M;
	const FVector End = FVector(HubXY.X, HubXY.Y, HubZ - Down) * McUnits::M;
	FCollisionQueryParams Params(SCENE_QUERY_STAT(McWheel), true, this);
	FHitResult Hit;
	if (!GetWorld()->SweepSingleByChannel(Hit, Start, End, FQuat::Identity, ECC_WorldStatic, FCollisionShape::MakeSphere(Tune::ProbeR * McUnits::M), Params))
	{
		return false;
	}
	if (Hit.bStartPenetrating) { return false; }
	OutGroundHub = Hit.Location.Z / McUnits::M + (Tune::WheelR - Tune::ProbeR);
	OutNormal = Hit.ImpactNormal;
	return true;
}

bool AMcBike::SweepBody(const FVector& From, const FVector& To, FHitResult& Hit) const
{
	const FVector2D F = Dir2(Yaw);
	const FVector Axis = FVector(F.X * FMath::Cos(Pitch), F.Y * FMath::Cos(Pitch), FMath::Sin(Pitch));
	const FQuat Rot = FQuat::FindBetweenNormals(FVector::UpVector, Axis);
	const FVector Lift(0.f, 0.f, 0.30f * McUnits::M);
	FCollisionQueryParams Params(SCENE_QUERY_STAT(McBody), true, this);
	return GetWorld()->SweepSingleByChannel(Hit, From + Lift, To + Lift, Rot, ECC_WorldStatic,
		FCollisionShape::MakeCapsule(0.26f * McUnits::M, 0.84f * McUnits::M), Params);
}

void AMcBike::AddShock(EMcShock Type, float Strength, float Damage)
{
	if (bGhost) { return; }
	if (bLandingOpen && (Type == EMcShock::Landing || Type == EMcShock::Rattle))
	{
		if (PendingLanding.bPerfect) { Damage *= Tune::PerfectScale; }
		PendingLanding.Damage += Damage;
		PendingLanding.ImpactSpeed = FMath::Max(PendingLanding.ImpactSpeed, Strength);
	}
	if (!bInvincible) { Condition = FMath::Max(0.f, Condition - Damage); }
	Shake = FMath::Clamp(Shake + Strength * 0.12f, 0.f, 1.f);
	// The box on the rider's back takes the hit too.
	PackageWobbleV[0] += FMath::FRandRange(-1.f, 1.f) * Strength * 1.4f;
	PackageWobbleV[1] += FMath::FRandRange(-1.f, 1.f) * Strength * 1.4f;
	PackageBounceV -= Strength * 0.25f;
	if (Damage > 0.05f)
	{
		UE_LOG(LogMc, Verbose, TEXT("MC_SHOCK type=%d strength=%.2f damage=%.2f braced=%d"), (int32)Type, Strength, Damage, bBraced ? 1 : 0);
	}
	if (Damage > 0.05f || Type == EMcShock::Crash || Type == EMcShock::Splash || Strength > 1.5f)
	{
		FMcShockEvent E;
		E.Type = Type; E.Strength = Strength; E.Damage = Damage; E.Location = GetPackageWorldLocation();
		PendingShocks.Add(E);
	}
}

void AMcBike::Crash(const TCHAR* Why)
{
	if (bCrashed || bGhost) { return; }
	UE_LOG(LogMc, Display, TEXT("MC_CRASH %s speed=%.1f"), Why, GetSpeed());
	bCrashed = true;
	CrashTime = 0.f;
	const bool bWater = FCString::Strcmp(Why, TEXT("water")) == 0;
	AddShock(bWater ? EMcShock::Splash : EMcShock::Crash, GetSpeed(), bWater ? 30.f : Tune::CrashDamage);
	CrashVel = GetWorldVelocity() * 0.55f + FVector(0, 0, 250.f);
	CrashSpin = FVector(FMath::FRandRange(-6.f, 6.f), FMath::FRandRange(3.f, 7.f), FMath::FRandRange(-3.f, 3.f));
	CrashRot = Frame->GetComponentQuat();
	CrashPos = Frame->GetComponentLocation();
	PackageFlyPos = GetPackageWorldLocation();
	PackageFlyVel = GetWorldVelocity() * 0.9f + FVector(0, 0, 420.f);
	PackageFlyRot = FQuat::Identity;
	PackageFlySpin = FVector(FMath::FRandRange(-9.f, 9.f), FMath::FRandRange(-9.f, 9.f), FMath::FRandRange(-4.f, 4.f));
}

void AMcBike::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (bGhost)
	{
		UpdateVisuals(DeltaSeconds);
		return;
	}
	bJustHopped = false;
	bJustTookOff = false;
	DeltaSeconds = FMath::Min(DeltaSeconds, 0.05f);
	if (bCrashed)
	{
		StepCrash(DeltaSeconds);
	}
	else if (!bFrozen)
	{
		Accumulator += DeltaSeconds;
		const float Dt = 1.f / Tune::StepHz;
		int32 Guard = 0;
		while (Accumulator >= Dt && Guard++ < 16)
		{
			Step(Dt);
			Accumulator -= Dt;
			if (bCrashed) { break; }
		}
	}
	Shake = FMath::Max(0.f, Shake - DeltaSeconds * 1.6f);
	UpdateVisuals(DeltaSeconds);
	UpdateCamera(DeltaSeconds);
	UpdateSpray(DeltaSeconds);
}

void AMcBike::Step(float Dt)
{
	using namespace Tune;
	const FMcInput& In = Input;

	// ---- input shaping ----------------------------------------------------------------------------------
	SteerSmooth = FMath::FInterpTo(SteerSmooth, FMath::Clamp(In.Steer, -1.f, 1.f), Dt, FMath::Abs(In.Steer) > FMath::Abs(SteerSmooth) ? 9.f : 12.f);

	BracePressedAgo += Dt;
	BraceReleasedAgo += Dt;
	if (In.bBrace && !bBracePrev) { BracePressedAgo = 0.f; BraceHold = 0.f; }
	if (In.bBrace) { BraceHold += Dt; }
	bool bHop = false;
	float HopCharge = 0.f;
	if (!In.bBrace && bBracePrev)
	{
		BraceReleasedAgo = 0.f;
		if (bGrounded && BraceHold > 0.06f) { bHop = true; HopCharge = FMath::Clamp(BraceHold / 0.32f, 0.f, 1.f); }
	}
	bBracePrev = In.bBrace;
	bBraced = In.bBrace;

	const FVector2D Fwd = Dir2(Yaw);
	const float CosP = FMath::Cos(Pitch), SinP = FMath::Sin(Pitch);
	const float VzStart = Vz;   // everything that changes Vz this step (springs, strikes) reaches the rider

	// ---- wheels: where is the ground? -------------------------------------------------------------------
	float Ground[2] = { 0.f, 0.f };
	float Arm[2] = { HalfBase * CosP, -HalfBase * CosP };
	float MountZ[2], MountV[2], Force[2] = { 0.f, 0.f };
	bool bAnyContact = false;
	for (int32 i = 0; i < 2; ++i)
	{
		StrikeTimer[i] -= Dt;
		const float Sign = i == 0 ? 1.f : -1.f;
		const FVector2D HubXY = PosXY + Fwd * (Sign * HalfBase * CosP);
		MountZ[i] = PosZ + Sign * HalfBase * SinP;
		MountV[i] = Vz + Arm[i] * PitchRate;
		FVector N = FVector::UpVector;
		bContact[i] = ProbeWheel(HubXY, MountZ[i], Ground[i], N);
		GroundNormal[i] = N;
		if (bContact[i])
		{
			Compression[i] = Ground[i] - (MountZ[i] - Ext);
			if (Compression[i] <= 0.f) { bContact[i] = false; }
		}
		else
		{
			Compression[i] = -1.f;
		}
		if (bContact[i])
		{
			bAnyContact = true;
			float GroundRate;
			if (bContactPrev[i])
			{
				GroundRate = (Ground[i] - GroundPrev[i]) / Dt;
			}
			else
			{
				// First touch: how fast the surface under a moving wheel rises from its slope.
				const FVector2D NXY(N.X, N.Y);
				GroundRate = N.Z > 0.3f ? -FVector2D::DotProduct(NXY, VelXY) / N.Z : 0.f;
			}
			GroundRate = FMath::Clamp(GroundRate, -14.f, 14.f);
			// Dampers see a bounded rate: a sharp edge shouldn't turn into a rocket.
			const float CompRate = FMath::Clamp(GroundRate - MountV[i], -8.f, 2.5f);
			Force[i] = FMath::Max(0.f, K * FMath::Min(Compression[i], MaxComp) + C * CompRate);

			// Past the fork's travel: the wheel can't go further into the frame. Shift the body up instead of
			// launching it (a real rider's arms and legs soak up most of a kerb), and only pass on a small
			// upward velocity, so smooth ramps still throw you but sharp edges just jolt.
			if (Compression[i] > MaxComp)
			{
				const float Pen = Compression[i] - MaxComp;
				const float InvM = 1.f + Arm[i] * Arm[i] / PitchInertia;
				PosZ += Pen / InvM;
				Pitch += Pen * (Arm[i] / PitchInertia) / InvM * 0.5f;
				const float Target = FMath::Min(GroundRate, EdgeLift);
				const float VRel = MountV[i] - Target;
				// Edges rising into the wheel hurt most; a wheel dropping onto a tread (stairs) hurts half as much.
				const float Jolt = FMath::Min(3.2f, FMath::Max(0.f, GroundRate) + 0.5f * FMath::Max(0.f, -MountV[i]));
				if (VRel < 0.f)
				{
					const float InvMSoft = 1.f + 0.5f * Arm[i] * Arm[i] / PitchInertia;
					const float J = -VRel / InvMSoft;
					Vz += J;
					PitchRate += 0.5f * J * Arm[i] / PitchInertia;
				}
				if (Jolt > 0.f)
				{
					// One edge is one strike: consecutive steps of the same climb only count their peak.
					if (StrikeTimer[i] <= 0.f) { StrikePeak[i] = 0.f; }
					StrikeTimer[i] = 0.07f;
					if (Jolt > StrikePeak[i])
					{
						auto F = [](float J) { return J > RattleThreshold ? RattleScale * FMath::Pow(J - RattleThreshold, RattleExp) : 0.f; };
						const float Dmg = (F(Jolt) - F(StrikePeak[i])) * (bBraced ? 0.4f : 1.f);
						// Each strike scrubs a little forward speed (stairs and kerbs slow you down a touch).
						const float Fs = FVector2D::DotProduct(VelXY, Fwd);
						VelXY -= Fwd * FMath::Clamp((Jolt - StrikePeak[i]) * 0.12f, 0.f, FMath::Abs(Fs) * 0.2f) * FMath::Sign(Fs);
						StrikePeak[i] = Jolt;
						AddShock(EMcShock::Rattle, Jolt, Dmg);
					}
				}
				Compression[i] = MaxComp;
			}
			GroundPrev[i] = Ground[i];
		}
		bContactPrev[i] = bContact[i];
	}

	// ---- landing / takeoff bookkeeping -------------------------------------------------------------------
	const bool bWasGrounded = bGrounded;
	if (bAnyContact)
	{
		GroundTime += Dt;
		if (!bWasGrounded)
		{
			if (AirTime > 0.18f)
			{
				// Touchdown. Open a short window to gather the damage this landing causes.
				bLandingOpen = true;
				LandingWindow = 0.35f;
				PendingLanding = FMcLandingEvent();
				PendingLanding.AirTime = AirTime;
				PendingLanding.DropHeight = FMath::Max(0.f, AirApexZ - PosZ);
				PendingLanding.bBraced = In.bBrace;
				PendingLanding.bPerfect = In.bBrace && BracePressedAgo < PerfectWindow;
				PendingLanding.ImpactSpeed = -Vz;

				// How well does the bike line up with the ground it lands on?
				const float TerrainPitch = bContact[0] && bContact[1] ? FMath::Atan2(Ground[0] - Ground[1], 2.f * HalfBase * CosP) : Pitch;
				const float PitchErr = FMath::Abs(FMath::RadiansToDegrees(Pitch - TerrainPitch));
				const float Speed2 = VelXY.Size();
				const float SlipDeg = Speed2 > 3.f ? FMath::RadiansToDegrees(FMath::Acos(FMath::Clamp(FVector2D::DotProduct(VelXY / Speed2, Fwd), -1.f, 1.f))) : 0.f;
				if ((PitchErr > 52.f && -Vz > 3.f) || SlipDeg > 75.f)
				{
					Crash(TEXT("landing"));
					return;
				}
				if (PitchErr > 26.f || SlipDeg > 35.f)
				{
					PendingLanding.bSketchy = true;
					PendingLanding.bPerfect = false;
					AddShock(EMcShock::Landing, PitchErr * 0.1f, PitchErr * 0.25f);
					VelXY *= 0.85f;
				}
			}
			AirTime = 0.f;
		}
	}
	else
	{
		if (bWasGrounded)
		{
			AirApexZ = PosZ;
			bJustTookOff = true;
		}
		AirTime += Dt;
		AirApexZ = FMath::Max(AirApexZ, PosZ);
		GroundTime = 0.f;
	}
	// Brief losses of contact (bumps, steps) don't count as being airborne.
	bGrounded = bAnyContact || (bWasGrounded && AirTime < 0.06f);

	if (bLandingOpen)
	{
		LandingWindow -= Dt;
		if (LandingWindow <= 0.f)
		{
			bLandingOpen = false;
			PendingLandings.Add(PendingLanding);
			UE_LOG(LogMc, Verbose, TEXT("MC_LANDING air=%.2f drop=%.2f impact=%.2f dmg=%.2f perfect=%d braced=%d"),
				PendingLanding.AirTime, PendingLanding.DropHeight, PendingLanding.ImpactSpeed, PendingLanding.Damage, PendingLanding.bPerfect, PendingLanding.bBraced);
		}
	}

	// ---- vertical rigid body ---------------------------------------------------------------------------
	Vz += (Force[0] + Force[1] - G) * Dt;
	PitchRate += (Force[0] * Arm[0] + Force[1] * Arm[1]) / PitchInertia * Dt;

	if (bHop)
	{
		const float Pop = 2.3f + 1.4f * HopCharge;
		Vz += Pop;
		PitchRate += 1.2f + 1.0f * HopCharge;   // front wheel comes up first
		TorsoV += 1.2f;
		bJustHopped = true;
	}

	if (!bAnyContact)
	{
		// Air control: lean to rotate, plus a gentle pull of the nose toward the flight path.
		const float FlightAngle = FMath::Atan2(Vz, FMath::Max(1.f, VelXY.Size()));
		const float Assist = FMath::Clamp(AirTime * 2.f, 0.f, 1.f) * (FMath::Abs(In.Lean) > 0.1f ? 0.25f : 1.f);
		PitchRate += (-In.Lean * 7.5f + (FMath::Clamp(FlightAngle, -1.1f, 0.6f) - Pitch) * 4.f * Assist) * Dt;
		PitchRate *= FMath::Exp(-1.2f * Dt);
	}
	else
	{
		PitchRate *= FMath::Exp(-2.f * Dt);
	}

	// ---- horizontal ------------------------------------------------------------------------------------
	const int32 NumContacts = (bContact[0] ? 1 : 0) + (bContact[1] ? 1 : 0);
	float FwdSpeed = FVector2D::DotProduct(VelXY, Fwd);
	float LatSpeed = FVector2D::DotProduct(VelXY, Right2(Yaw));
	const float AbsSpeed = FMath::Abs(FwdSpeed);
	bDriftActive = false;
	if (NumContacts > 0)
	{
		const float Traction = NumContacts == 2 ? 1.f : 0.75f;
		// Gravity along the slope the wheels sit on.
		const float TerrainPitch = NumContacts == 2 ? FMath::Atan2(Ground[0] - Ground[1], 2.f * HalfBase * CosP) : Pitch;
		FwdSpeed += -G * FMath::Sin(TerrainPitch) * FMath::Cos(TerrainPitch) * Dt;

		// Pedalling (not while standing to brace).
		if (In.Throttle > 0.01f && !bBraced && bContact[1])
		{
			const float Cadence = 1.f - FMath::Clamp((AbsSpeed - CadenceFull) / (CadenceZero - CadenceFull), 0.f, 1.f);
			const float A = FMath::Min(PedalAccelMax, Power / FMath::Max(AbsSpeed, 1.f)) * Cadence * In.Throttle;
			FwdSpeed += A * Dt;
		}
		// Brakes and rolling resistance oppose motion and never reverse it.
		const float Oppose = (In.Brake * BrakeDecel * Traction + RollRes + (In.bDrift ? DriftDecel : 0.f)) * Dt;
		FwdSpeed = FwdSpeed > 0.f ? FMath::Max(0.f, FwdSpeed - Oppose) : FMath::Min(0.f, FwdSpeed + Oppose);

		// Steering: a yaw-rate envelope that is tight at walking pace and lean-limited at speed.
		float MaxRate = FMath::Min(AbsSpeed / MinRadius, LeanTurn / FMath::Max(AbsSpeed, 0.5f) + 0.35f);
		const bool bDrift = In.bDrift && AbsSpeed > 4.f;
		if (bDrift) { MaxRate *= 1.6f; bDriftActive = true; }
		if (bBraced) { MaxRate *= 0.85f; }
		const float TargetRate = SteerSmooth * MaxRate * (FwdSpeed >= 0.f ? 1.f : -1.f);
		YawRate = FMath::FInterpTo(YawRate, TargetRate, Dt, 11.f * Traction);
		Yaw += YawRate * Dt;

		// Grip pulls the velocity back in line with the wheels; a slide bleeds speed.
		const FVector2D NewFwd = Dir2(Yaw), NewRight = Right2(Yaw);
		const FVector2D VOld = Fwd * FwdSpeed + Right2(Yaw - YawRate * Dt) * LatSpeed;
		float S = FVector2D::DotProduct(VOld, NewFwd);
		const float L = FVector2D::DotProduct(VOld, NewRight);
		const float GripNow = (bDrift ? DriftGrip : Grip) * Traction;
		const float LNew = L * FMath::Exp(-GripNow * Dt);
		const float Keep = bDrift ? 0.55f : 0.9f;
		const float Gain = FMath::Max(0.f, L * L - LNew * LNew) * Keep;
		S = (S >= 0.f ? 1.f : -1.f) * FMath::Sqrt(S * S + Gain);
		VelXY = NewFwd * S + NewRight * LNew;
		SlipAmount = FMath::FInterpTo(SlipAmount, FMath::Clamp(FMath::Abs(LNew) / 3.f, 0.f, 1.f), Dt, 8.f);
		RollAmount = FMath::Clamp(AbsSpeed / 12.f, 0.f, 1.f);
	}
	else
	{
		// Airborne: tiny yaw control, keep momentum.
		YawRate = FMath::FInterpTo(YawRate, SteerSmooth * 1.3f, Dt, 3.f);
		Yaw += YawRate * Dt;
		SlipAmount = FMath::FInterpTo(SlipAmount, 0.f, Dt, 4.f);
		RollAmount = 0.f;
	}

	// Aerodynamic drag on everything.
	{
		const float Sp = FMath::Sqrt(VelXY.SizeSquared() + Vz * Vz);
		const float Dec = Drag * Sp * Sp * Dt;
		if (Sp > 0.01f)
		{
			const float Scale = FMath::Max(0.f, Sp - Dec) / Sp;
			VelXY *= Scale;
			Vz = Vz * (bAnyContact ? 1.f : Scale);
		}
	}

	// ---- move, colliding the frame with walls -----------------------------------------------------------
	const FVector2D HorizBefore = VelXY;
	FVector Pos = FVector(PosXY.X, PosXY.Y, PosZ) * McUnits::M;
	FVector Delta = FVector(VelXY.X, VelXY.Y, 0.f) * Dt * McUnits::M;
	for (int32 Iter = 0; Iter < 3 && !Delta.IsNearlyZero(0.01f); ++Iter)
	{
		FHitResult Hit;
		if (!SweepBody(Pos, Pos + Delta, Hit))
		{
			Pos += Delta;
			break;
		}
		if (Hit.bStartPenetrating)
		{
			Pos += Hit.Normal * (Hit.PenetrationDepth + 0.5f);
			continue;
		}
		Pos = Hit.Location - FVector(0, 0, 0.30f * McUnits::M) + Hit.Normal * 0.2f;
		FVector2D N(Hit.Normal.X, Hit.Normal.Y);
		if (N.SizeSquared() < 0.04f) { break; }
		N.Normalize();
		const float Into = -FVector2D::DotProduct(VelXY, N);
		if (Into > 0.f)
		{
			const float Restitution = 0.15f;
			VelXY += N * Into * (1.f + Restitution);
			const float Frontal = FMath::Abs(FVector2D::DotProduct(Dir2(Yaw), N));
			// Scrape along the wall: turn the bike toward the slide direction.
			const FVector2D Slide = VelXY.GetSafeNormal();
			if (!Slide.IsNearlyZero() && Frontal < 0.85f)
			{
				float Target = FMath::Atan2(Slide.Y, Slide.X);
				if (FwdSpeed < 0.f) { Target += PI; }
				Yaw += FMath::FindDeltaAngleRadians(Yaw, Target) * 0.35f;
			}
			YawRate *= 0.5f;
			if (Into > CrashWallSpeed && Frontal > 0.6f)
			{
				Crash(TEXT("wall"));
				return;
			}
			const float Dmg = Into > WallThreshold ? WallScale * FMath::Pow(Into - WallThreshold, WallExp) : 0.f;
			AddShock(EMcShock::Wall, Into, Dmg);
		}
		const float Remaining = 1.f - Hit.Time;
		const FVector DeltaRemain = Delta * Remaining;
		const FVector N3(N.X, N.Y, 0.f);
		Delta = DeltaRemain - N3 * FVector::DotProduct(DeltaRemain, N3);
	}
	PosXY = FVector2D(Pos.X, Pos.Y) / McUnits::M;

	// Vertical integration.
	PosZ += Vz * Dt;
	PitchRate = FMath::Clamp(PitchRate, -6.f, 6.f);
	Pitch += PitchRate * Dt;
	Pitch = FMath::Clamp(Pitch, -1.45f, 1.45f);

	// Fell in the water (or through the world)?
	for (const FWater& W : Water)
	{
		if (W.Area.IsInside(PosXY * McUnits::M) && PosZ < W.Z / McUnits::M + 0.3f)
		{
			Crash(TEXT("water"));
			return;
		}
	}
	if (PosZ < -3.f)
	{
		Crash(TEXT("water"));
		return;
	}

	// ---- the rider's legs and the package ----------------------------------------------------------------
	{
		const float Az = (Vz - VzStart) / Dt;   // vertical acceleration of the frame (includes -g in flight)
		const float Kt = bBraced ? BraceK : SeatK;
		const float Ct = bBraced ? BraceC : SeatC;
		const float Cap = bBraced ? BraceCap : SeatCap;
		const float UMin = bBraced ? BraceMin : SeatMin;
		const float UMax = bBraced ? BraceMax : SeatMax;
		float Ft = FMath::Clamp(Kt * (0.f - TorsoU) - Ct * TorsoV, 0.f, Cap);
		const float PrevU = TorsoU;
		TorsoV += (Ft - G - Az) * Dt;
		TorsoU += TorsoV * Dt;
		if (TorsoU < UMin && PrevU < UMin - 0.002f)
		{
			// Sitting back down from a crouch: the legs extend into the seated range, no harm done.
			TorsoU = FMath::Min(UMin, PrevU + 1.5f * Dt);
			TorsoV = FMath::Max(TorsoV, 0.f);
		}
		else if (TorsoU < UMin)
		{
			// Legs (or seat) bottomed out: the package feels the whole remaining velocity at once.
			const float Hit = -TorsoV;
			TorsoU = UMin;
			if (Hit > 0.f)
			{
				TorsoV = 0.f;
				const float Dmg = Hit > LegThreshold ? LegScale * FMath::Pow(Hit - LegThreshold, LegExp) * (bBraced ? 0.6f : 1.f) : 0.f;
				AddShock(EMcShock::Landing, Hit, Dmg);
				Ft = Cap + Hit / Dt * 0.02f;
			}
		}
		else if (TorsoU > UMax)
		{
			TorsoU = UMax;
			TorsoV = FMath::Min(TorsoV, 0.f);
		}
		const FVector2D HAcc = (VelXY - HorizBefore) / Dt;
		const float Felt = FMath::Sqrt(Ft * Ft + HAcc.SizeSquared() * 0.25f) / G;
		PackageG = FMath::Lerp(PackageG, Felt, 0.25f);
		if (Felt > GSafe)
		{
			const float Dmg = GScale * FMath::Pow(Felt - GSafe, GExp) * Dt;
			if (!bInvincible) { Condition = FMath::Max(0.f, Condition - Dmg); }
			if (bLandingOpen) { PendingLanding.Damage += Dmg; }
		}
	}

	// Package wobble (visual): a damped spring kicked by accelerations.
	{
		const float Fs = FVector2D::DotProduct(VelXY - HorizBefore, Dir2(Yaw)) / Dt;
		const float Ls = FVector2D::DotProduct(VelXY - HorizBefore, Right2(Yaw)) / Dt;
		const float Kicks[2] = { -Fs * 0.006f, Ls * 0.006f + YawRate * FwdSpeed * 0.004f };
		for (int32 k = 0; k < 2; ++k)
		{
			PackageWobbleV[k] += (-90.f * PackageWobble[k] - 5.f * PackageWobbleV[k]) * Dt + Kicks[k] * Dt * 30.f;
			PackageWobble[k] += PackageWobbleV[k] * Dt;
			PackageWobble[k] = FMath::Clamp(PackageWobble[k], -0.6f, 0.6f);
		}
		PackageBounceV += (-160.f * PackageBounce - 7.f * PackageBounceV) * Dt;
		PackageBounce += PackageBounceV * Dt;
		PackageBounce = FMath::Clamp(PackageBounce, -0.08f, 0.08f);
	}

	// Lean (visual + camera): what a real bike needs for this turn.
	{
		const float Sp = FMath::Abs(FwdSpeed);
		float Target = bGrounded ? FMath::Atan(Sp * YawRate / G) : Lean * 0.98f;
		if (bDriftActive) { Target *= 1.15f; }
		Target = FMath::Clamp(Target, -0.85f, 0.85f);
		Lean = FMath::FInterpTo(Lean, Target, Dt, 7.f);
	}

	// Wheels and cranks.
	WheelAngle += FwdSpeed / WheelR * Dt;
	if (In.Throttle > 0.05f && !bBraced && bGrounded)
	{
		CrankAngle += FMath::Clamp(FwdSpeed, 2.f, 14.f) / 2.2f * Dt * (0.6f + 0.4f * In.Throttle);
	}
	else
	{
		// Coasting: feet come level (cranks horizontal).
		const float Level = FMath::RoundToFloat((CrankAngle - HALF_PI) / PI) * PI + HALF_PI;
		CrankAngle = FMath::FInterpTo(CrankAngle, Level, Dt, 5.f);
	}

	if (Condition <= 0.f && !bInvincible)
	{
		Condition = 0.f;
	}
}

void AMcBike::StepCrash(float Dt)
{
	CrashTime += Dt;
	CrashVel.Z -= 980.f * Dt;
	FVector Next = CrashPos + CrashVel * Dt;
	FHitResult Hit;
	FCollisionQueryParams Params(SCENE_QUERY_STAT(McCrash), true, this);
	if (GetWorld()->SweepSingleByChannel(Hit, CrashPos, Next, FQuat::Identity, ECC_WorldStatic, FCollisionShape::MakeSphere(30.f), Params))
	{
		Next = Hit.Location + Hit.Normal * 1.f;
		const FVector N = Hit.Normal;
		const float Into = FVector::DotProduct(CrashVel, N);
		CrashVel -= N * Into * 1.35f;
		CrashVel *= 0.6f;
		CrashSpin *= 0.55f;
	}
	CrashPos = Next;
	CrashRot = FQuat(CrashSpin.GetSafeNormal(), CrashSpin.Size() * Dt) * CrashRot;
	CrashRot.Normalize();

	PackageFlyVel.Z -= 980.f * Dt;
	FVector PNext = PackageFlyPos + PackageFlyVel * Dt;
	if (GetWorld()->SweepSingleByChannel(Hit, PackageFlyPos, PNext, FQuat::Identity, ECC_WorldStatic, FCollisionShape::MakeSphere(15.f), Params))
	{
		PNext = Hit.Location + Hit.Normal;
		const float Into = FVector::DotProduct(PackageFlyVel, Hit.Normal);
		PackageFlyVel -= Hit.Normal * Into * 1.4f;
		PackageFlyVel *= 0.55f;
		PackageFlySpin *= 0.6f;
	}
	PackageFlyPos = PNext;
	PackageFlyRot = FQuat(PackageFlySpin.GetSafeNormal(), PackageFlySpin.Size() * Dt) * PackageFlyRot;
}

FTransform AMcBike::GetBodyTransform() const
{
	return Frame->GetComponentTransform();
}

FVector AMcBike::GetPackageWorldLocation() const
{
	if (const UStaticMeshComponent* P = Part("Pack")) { return P->GetComponentLocation(); }
	return GetWorldLocation();
}

FVector AMcBike::GetHeadLampLocation() const { return HeadLight->GetComponentLocation(); }
FVector AMcBike::GetHeadLampDirection() const { return HeadLight->GetForwardVector(); }

void AMcBike::SetPoseFromRecording(const FVector& Loc, const FRotator& Rot, float Crank, float WheelSpin, float Crouch)
{
	bUseRecordedPose = true;
	PosXY = FVector2D(Loc.X, Loc.Y) / McUnits::M;
	PosZ = Loc.Z / McUnits::M;
	Yaw = FMath::DegreesToRadians(Rot.Yaw);
	Pitch = FMath::DegreesToRadians(Rot.Pitch);
	Lean = FMath::DegreesToRadians(Rot.Roll);
	CrankAngle = Crank;
	WheelAngle = WheelSpin;
	TorsoU = Crouch;
	Compression[0] = Compression[1] = Tune::Sag;
}

void AMcBike::UpdateVisuals(float Dt)
{
	// Body transform: yaw and pitch about the body centre, lean about the line where the tyres touch.
	const float HubDrop = Tune::WheelR + Tune::Ext - Tune::Sag;
	const FVector Center = FVector(PosXY.X, PosXY.Y, PosZ) * McUnits::M;
	if (bCrashed)
	{
		Frame->SetWorldLocationAndRotation(CrashPos, CrashRot);
	}
	else
	{
		const FQuat YawPitch = FRotator(FMath::RadiansToDegrees(Pitch), FMath::RadiansToDegrees(Yaw), 0.f).Quaternion();
		// FRotator roll is minus the rotation about +X: lean into the turn (right turn = right side down).
		const FQuat LeanQ = FQuat(FVector::ForwardVector, -Lean);
		const FVector Pivot(0, 0, -HubDrop * McUnits::M);
		const FVector LeanOffset = LeanQ.RotateVector(-Pivot) + Pivot;
		const FQuat Total = YawPitch * LeanQ;
		Frame->SetWorldLocationAndRotation(Center + YawPitch.RotateVector(LeanOffset), Total);
	}
	SetActorLocation(Center, false, nullptr, ETeleportType::TeleportPhysics);
	Root->SetWorldLocation(Center);
	Frame->SetWorldLocationAndRotation(Frame->GetComponentLocation(), Frame->GetComponentQuat());

	// Wheels sit at their suspension travel and spin.
	const float Spin = -FMath::RadiansToDegrees(WheelAngle);
	for (int32 i = 0; i < 2; ++i)
	{
		UStaticMeshComponent* W = Part(i == 0 ? "WheelF" : "WheelR");
		if (!W) { continue; }
		const float Comp = FMath::Clamp(Compression[i] > 0.f ? Compression[i] : 0.f, 0.f, Tune::MaxComp);
		const float Z = -(Tune::Ext - Comp) * McUnits::M;
		W->SetRelativeLocation(FVector((i == 0 ? 1.f : -1.f) * Tune::HalfBase * McUnits::M, 0.f, Z));
		W->SetRelativeRotation(FRotator(Spin, 0.f, 0.f));
	}
	if (UStaticMeshComponent* F = Part("Fork"))
	{
		const float Comp = FMath::Clamp(Compression[0] > 0.f ? Compression[0] : 0.f, 0.f, Tune::MaxComp);
		F->SetRelativeLocation(FVector(Tune::HalfBase * McUnits::M, 0.f, -(Tune::Ext - Comp) * McUnits::M));
		F->SetRelativeRotation(FRotator(0.f, SteerSmooth * 14.f, 0.f));
	}
	UpdateRider(Dt);
}

void AMcBike::UpdateRider(float Dt)
{
	// All positions in the frame's local space (cm). Body centre is the origin; X forward, Z up.
	// Fixed bike points (must match the Blender model, see Art/bike.py).
	const FVector BB(2.f, 0.f, -18.f);           // bottom bracket
	const float CrankLen = 17.f;
	const FVector Seat(-20.f, 0.f, 58.f);
	const FVector Bars(44.f, 0.f, 64.f);
	const float Thigh = 44.f, Shin = 44.f, UpperArm = 30.f, ForeArm = 28.f, TorsoLen = 56.f;

	// Crank.
	const float CrankDeg = FMath::RadiansToDegrees(CrankAngle);
	if (UStaticMeshComponent* C = Part("Crank"))
	{
		C->SetRelativeLocation(BB);
		C->SetRelativeRotation(FRotator(-CrankDeg, 0.f, 0.f));
	}
	FVector Pedal[2];
	for (int32 s = 0; s < 2; ++s)
	{
		const float A = CrankAngle + (s == 0 ? 0.f : PI);
		Pedal[s] = BB + FVector(FMath::Sin(A) * CrankLen, (s == 0 ? -1.f : 1.f) * 11.f, FMath::Cos(A) * CrankLen);
		if (UStaticMeshComponent* P = Part(s == 0 ? "PedalL" : "PedalR"))
		{
			P->SetRelativeLocation(Pedal[s]);
			P->SetRelativeRotation(FRotator::ZeroRotator);
		}
	}

	// Hips: on the saddle, or standing on the pedals when braced. TorsoU is the legs' spring.
	float& Stand = StandBlend;
	Stand = FMath::FInterpTo(Stand, bBraced ? 1.f : 0.f, Dt, 9.f);
	if (bCrashed) { Stand = 0.5f; }
	const float Speed = GetSpeed();
	const float Lift = Stand * 30.f;
	const FVector Hip = Seat + FVector(-6.f * Stand, 0.f, 6.f + Lift + TorsoU * 100.f * (0.35f + 0.65f * Stand));

	// Torso leans forward to the bars; more at speed (tuck) and when standing (attack position).
	const float Tuck = FMath::Clamp(Speed / 14.f, 0.f, 1.f);
	const float TorsoPitch = FMath::DegreesToRadians(38.f - 8.f * Tuck + 6.f * Stand + FMath::Clamp(TorsoV * 8.f, -10.f, 10.f));
	const FVector TorsoDir(FMath::Cos(TorsoPitch), 0.f, FMath::Sin(TorsoPitch));
	const FVector Neck = Hip + TorsoDir * TorsoLen;
	// The rider's back (up and behind when leaning over the bars).
	const FVector TorsoUp = FVector::CrossProduct(TorsoDir, FVector(0, 1, 0)).GetSafeNormal();

	if (UStaticMeshComponent* P = Part("Pelvis")) { P->SetRelativeLocationAndRotation(Hip, Along(TorsoDir, TorsoUp)); }
	if (UStaticMeshComponent* P = Part("Torso")) { P->SetRelativeLocationAndRotation(Hip, Along(TorsoDir, TorsoUp)); }
	if (UStaticMeshComponent* P = Part("Head"))
	{
		const FRotator Look(-10.f, SteerSmooth * 18.f, 0.f);
		P->SetRelativeLocationAndRotation(Neck + TorsoDir * 4.f, Look);
	}

	// Package on the back: rides the torso, bounces and wobbles on its straps.
	if (UStaticMeshComponent* P = Part("Pack"))
	{
		const FVector Back = Hip + TorsoDir * (TorsoLen * 0.55f) + TorsoUp * (17.f + PackageBounce * 100.f);
		if (bCrashed)
		{
			P->SetWorldLocationAndRotation(PackageFlyPos, PackageFlyRot);
		}
		else
		{
			const FRotator Base = Along(TorsoDir, TorsoUp);
			const FQuat Wob = FRotator(FMath::RadiansToDegrees(PackageWobble[0]) * 0.6f, 0.f, FMath::RadiansToDegrees(PackageWobble[1]) * 0.6f).Quaternion();
			P->SetRelativeLocationAndRotation(Back, Base.Quaternion() * Wob);
		}
	}

	// Legs: two-bone IK from hip to pedal, knees forward and slightly out.
	FVector HipJ[2], KneeJ[2], FootJ[2], ShJ[2], ElbowJ[2], GripJ[2];
	for (int32 s = 0; s < 2; ++s)
	{
		const float Side = s == 0 ? -1.f : 1.f;
		const FVector H = Hip + FVector(0.f, Side * 10.f, 0.f);
		const FVector Foot = Pedal[s] + FVector(-3.f, Side * 2.f, 5.f);
		const FVector Knee = SolveIK(H, Foot, Thigh, Shin, FVector(1.f, Side * 0.15f, 0.4f));
		HipJ[s] = H; KneeJ[s] = Knee; FootJ[s] = Foot;
		if (UStaticMeshComponent* P = Part(s == 0 ? "ThighL" : "ThighR")) { P->SetRelativeLocationAndRotation(H, Along(Knee - H, FVector::UpVector)); }
		if (UStaticMeshComponent* P = Part(s == 0 ? "ShinL" : "ShinR")) { P->SetRelativeLocationAndRotation(Knee, Along(Foot - Knee, FVector::ForwardVector)); }
		if (UStaticMeshComponent* P = Part(s == 0 ? "FootL" : "FootR")) { P->SetRelativeLocationAndRotation(Foot, FRotator(0.f, 0.f, 0.f)); }
	}

	// Arms: shoulders to the grips, elbows out and down.
	const FVector Shoulder = Neck - TorsoDir * 5.f;
	const float SteerYaw = FMath::DegreesToRadians(SteerSmooth * 14.f);
	for (int32 s = 0; s < 2; ++s)
	{
		const float Side = s == 0 ? -1.f : 1.f;
		const FVector Sh = Shoulder + FVector(0.f, Side * 18.f, 0.f);
		// Grips swing around the steering axis.
		const FVector Grip = Bars + FVector(FMath::Sin(SteerYaw) * Side * 27.f * -1.f, Side * 27.f * FMath::Cos(SteerYaw), 0.f);
		const FVector Elbow = SolveIK(Sh, Grip, UpperArm, ForeArm, FVector(-0.3f, Side * 0.8f, -0.5f));
		ShJ[s] = Sh; ElbowJ[s] = Elbow; GripJ[s] = Grip;
		if (UStaticMeshComponent* P = Part(s == 0 ? "UpperArmL" : "UpperArmR")) { P->SetRelativeLocationAndRotation(Sh, Along(Elbow - Sh, FVector::UpVector)); }
		if (UStaticMeshComponent* P = Part(s == 0 ? "ForeArmL" : "ForeArmR")) { P->SetRelativeLocationAndRotation(Elbow, Along(Grip - Elbow, FVector::UpVector)); }
	}

	// Skinned rider: every bone aimed from its joint toward the next, relative to the modelled rest pose.
	static const bool bNoPose = FParse::Param(FCommandLine::Get(), TEXT("McNoPose"));
	if (RiderMesh && RiderBones.Num() > 0 && !bNoPose)
	{
		auto Rest = [this](const TCHAR* N) { const FRiderBone* B = RiderBones.Find(N); return B ? B->RestCS.GetLocation() : FVector::ZeroVector; };
		auto BackOf = [](const FVector& D) { return FVector::CrossProduct(D, FVector(0, 1, 0)).GetSafeNormal(); };
		const FVector Pelvis = Hip, Spine = Hip + TorsoDir * 20.f, Chest = Hip + TorsoDir * 38.f, NeckJ = Neck - TorsoDir * 2.f;
		const FVector HeadJ = Neck + TorsoDir * 4.f + FVector(0, 0, 5.f);
		const FVector RP = Rest(TEXT("pelvis")), RS = Rest(TEXT("spine")), RC = Rest(TEXT("chest")), RN = Rest(TEXT("neck")), RH = Rest(TEXT("head"));
		PoseBone("pelvis", Pelvis, Spine - Pelvis, BackOf(Spine - Pelvis), RS - RP, BackOf(RS - RP));
		PoseBone("spine", Spine, Chest - Spine, BackOf(Chest - Spine), RC - RS, BackOf(RC - RS));
		PoseBone("chest", Chest, NeckJ - Chest, BackOf(NeckJ - Chest), RN - RC, BackOf(RN - RC));
		PoseBone("neck", NeckJ, HeadJ - NeckJ, BackOf(HeadJ - NeckJ), RH - RN, BackOf(RH - RN));
		{
			// Head stays upright and looks into the turn.
			const FQuat Look(FVector::UpVector, SteerSmooth * 0.32f);
			const FVector RestDir(3.f, 0.f, 22.f);
			PoseBone("head", HeadJ, Look.RotateVector(RestDir), Look.RotateVector(FVector(0, 1, 0)), RestDir, FVector(0, 1, 0), true);
		}
		const TCHAR* LegSfx[2] = { TEXT("_l"), TEXT("_r") };
		for (int32 s = 0; s < 2; ++s)
		{
			const float Side = s == 0 ? -1.f : 1.f;
			const FString Sfx = LegSfx[s];
			const FName Th(*(TEXT("thigh") + Sfx)), Sh(*(TEXT("shin") + Sfx)), Ft(*(TEXT("foot") + Sfx));
			const FName Ua(*(TEXT("upperarm") + Sfx)), Fa(*(TEXT("forearm") + Sfx)), Hd(*(TEXT("hand") + Sfx));
			const FVector KneeHint(1.f, Side * 0.15f, 0.4f), ElbowHint(-0.3f, Side * 0.8f, -0.5f);
			const FVector RTh = Rest(*Th.ToString()), RSh = Rest(*Sh.ToString()), RFt = Rest(*Ft.ToString());
			const FVector RUa = Rest(*Ua.ToString()), RFa = Rest(*Fa.ToString()), RHd = Rest(*Hd.ToString());
			PoseBone(Th, HipJ[s], KneeJ[s] - HipJ[s], KneeHint, RSh - RTh, KneeHint);
			PoseBone(Sh, KneeJ[s], FootJ[s] - KneeJ[s], KneeHint, RFt - RSh, KneeHint);
			const FVector FootDir(16.f, 0.f, -4.f);
			PoseBone(Ft, FootJ[s], FootDir, FVector::UpVector, FootDir, FVector::UpVector);
			PoseBone(Ua, ShJ[s], ElbowJ[s] - ShJ[s], ElbowHint, RFa - RUa, ElbowHint);
			PoseBone(Fa, ElbowJ[s], GripJ[s] - ElbowJ[s], ElbowHint, RHd - RFa, ElbowHint);
			const FQuat Steer(FVector::UpVector, SteerYaw);
			const FVector HandDir(9.f, 0.f, -1.f);
			PoseBone(Hd, GripJ[s], Steer.RotateVector(HandDir), FVector::UpVector, HandDir, FVector::UpVector);
		}
	}
}

void AMcBike::SnapCamera()
{
	bCamInit = false;
	UpdateCamera(0.f);
}

void AMcBike::UpdateCamera(float Dt)
{
	if (bGhost) { return; }
	const FVector Target = bCrashed ? CrashPos : GetWorldLocation();
	const float Speed = GetSpeed();
	const FVector2D V2 = VelXY;
	const float VelYawDeg = V2.Size() > 2.f ? FMath::RadiansToDegrees(FMath::Atan2(V2.Y, V2.X)) : GetYawDeg();
	// Look where the bike is headed, blended toward where it's pointing at low speed.
	const float HeadingYaw = GetYawDeg();
	const float DesiredYaw = HeadingYaw + FMath::Clamp(FMath::FindDeltaAngleDegrees(HeadingYaw, VelYawDeg), -35.f, 35.f) * 0.5f;
	const float DesiredPitch = -11.f + FMath::Clamp(GetPitchDeg() * 0.45f, -14.f, 8.f) - FMath::Clamp(Speed * 0.15f, 0.f, 2.f);
	const float DesiredFov = 78.f + FMath::Clamp((Speed - 6.f) * 1.3f, 0.f, 16.f);
	const float DesiredDist = 400.f + FMath::Clamp(Speed * 6.f, 0.f, 70.f);

	if (!bCamInit || Dt <= 0.f)
	{
		CamYaw = DesiredYaw; CamPitch = DesiredPitch; CamFov = DesiredFov; CamDist = DesiredDist;
		CamPos = Target;
		bCamInit = true;
	}
	else
	{
		const float YawSpeed = bGrounded ? 7.5f : 2.5f;
		CamYaw += FMath::FindDeltaAngleDegrees(CamYaw, DesiredYaw) * FMath::Min(1.f, Dt * YawSpeed);
		CamPitch = FMath::FInterpTo(CamPitch, DesiredPitch, Dt, 3.f);
		CamFov = FMath::FInterpTo(CamFov, DesiredFov, Dt, 2.f);
		CamDist = FMath::FInterpTo(CamDist, DesiredDist, Dt, 2.f);
		// Follow the target tightly horizontally, softly vertically (landings read as a dip, not a jolt).
		const FVector Lag = Target - CamPos;
		CamPos.X += Lag.X * FMath::Min(1.f, Dt * 14.f);
		CamPos.Y += Lag.Y * FMath::Min(1.f, Dt * 14.f);
		CamPos.Z += Lag.Z * FMath::Min(1.f, Dt * (bGrounded ? 9.f : 6.f));
	}

	const FRotator Rot(CamPitch, CamYaw, FMath::RadiansToDegrees(Lean) * 0.18f);
	const FVector Pivot = CamPos + FVector(0, 0, 150.f);
	FVector Desired = Pivot - Rot.Vector() * CamDist + FVector(0, 0, 40.f);

	// Keep the camera out of walls.
	FHitResult Hit;
	FCollisionQueryParams Params(SCENE_QUERY_STAT(McCam), false, this);
	if (GetWorld()->SweepSingleByChannel(Hit, Pivot, Desired, FQuat::Identity, ECC_WorldStatic, FCollisionShape::MakeSphere(22.f), Params))
	{
		Desired = Hit.Location;
	}

	// Shake from shocks.
	const float T = GetWorld()->GetTimeSeconds();
	const float Sh = Shake * Shake * (FMcSettings::Get().Shake / 10.f);
	const FVector Jitter(FMath::Sin(T * 61.f) * 3.f, FMath::Sin(T * 53.f + 1.f) * 3.f, FMath::Sin(T * 71.f + 2.f) * 4.f);
	const FRotator RotJ(FMath::Sin(T * 47.f) * 1.2f * Sh, FMath::Sin(T * 39.f) * 0.8f * Sh, 0.f);

	FVector Loc = Desired + Jitter * Sh;
	FRotator Look = (Pivot + Rot.Vector() * 300.f - Loc).Rotation();
	Look.Roll = Rot.Roll;
	Look += RotJ;
	Camera->SetWorldLocationAndRotation(Loc, Look);
	Camera->SetFieldOfView(CamFov);
	if (bCameraOverride)
	{
		Camera->SetWorldLocationAndRotation(OverrideLoc, OverrideRot);
		Camera->SetFieldOfView(OverrideFov);
	}
}

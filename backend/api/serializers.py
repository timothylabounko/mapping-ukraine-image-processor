import math

from rest_framework import serializers
from PIL import Image as PILImage
from PIL.ExifTags import TAGS, GPSTAGS
from .models import User, Image


def _reset_upload(file):
    if hasattr(file, "seek"):
        file.seek(0)


def _ratio_to_float(x):
    """Convert EXIF rationals, (num, den) tuples, or numbers to float."""
    if x is None:
        return float("nan")
    try:
        if hasattr(x, "numerator") and hasattr(x, "denominator"):
            d = float(x.denominator)
            if d == 0:
                return float("nan")
            return float(x.numerator) / d
        if isinstance(x, (tuple, list)):
            if len(x) == 2:
                a, b = float(x[0]), float(x[1])
                if b == 0:
                    return float("nan")
                return a / b
            if len(x) == 1:
                return float(x[0])
        return float(x)
    except (TypeError, ValueError, ZeroDivisionError):
        return float("nan")


def _dms_tuple_to_decimal(dms, ref, is_latitude):
    """
    Convert EXIF GPS DMS (degrees, minutes, seconds) to signed decimal degrees.
    ref is N/S for latitude or E/W for longitude (str or bytes).
    """
    if not dms or not isinstance(dms, (tuple, list)) or len(dms) < 3:
        return None
    deg = _ratio_to_float(dms[0])
    minutes = _ratio_to_float(dms[1])
    seconds = _ratio_to_float(dms[2])
    if not all(math.isfinite(v) for v in (deg, minutes, seconds)):
        return None
    val = deg + minutes / 60.0 + seconds / 3600.0
    if not math.isfinite(val):
        return None

    if isinstance(ref, bytes):
        ref_s = ref.decode("ascii", errors="ignore").strip().upper()
    else:
        ref_s = str(ref).strip().upper() if ref is not None else ""

    if is_latitude:
        if ref_s == "S":
            val = -val
        elif ref_s != "N":
            return None
        if abs(val) > 90:
            return None
    else:
        if ref_s == "W":
            val = -val
        elif ref_s != "E":
            return None
        if abs(val) > 180:
            return None

    return val if math.isfinite(val) else None


def get_exif_location(file):
    """
    Extract GPS coordinates from image EXIF data.
    Returns (latitude, longitude) or (None, None) if not found.
    Resets the file pointer so Django can save the upload afterward.
    """
    _reset_upload(file)
    try:
        img = PILImage.open(file)
        exif = img._getexif()
        if not exif:
            _reset_upload(file)
            return None, None
        gps_info = {}
        for tag, value in exif.items():
            decoded = TAGS.get(tag, tag)
            if decoded == "GPSInfo":
                for t in value:
                    sub_decoded = GPSTAGS.get(t, t)
                    gps_info[sub_decoded] = value[t]

        lat_dms = gps_info.get("GPSLatitude")
        lat_ref = gps_info.get("GPSLatitudeRef")
        lon_dms = gps_info.get("GPSLongitude")
        lon_ref = gps_info.get("GPSLongitudeRef")

        if lat_dms and lon_dms and lat_ref is not None and lon_ref is not None:
            lat = _dms_tuple_to_decimal(lat_dms, lat_ref, is_latitude=True)
            lon = _dms_tuple_to_decimal(lon_dms, lon_ref, is_latitude=False)
            if lat is not None and lon is not None and math.isfinite(lat) and math.isfinite(lon):
                _reset_upload(file)
                return lat, lon
    except Exception:
        _reset_upload(file)
        return None, None

    _reset_upload(file)
    return None, None


def _sanitize_lat_lon_azimuth(mut):
    """Normalize optional coords; drop NaN/inf and out-of-range values (safe for JSON)."""
    for field in ('latitude', 'longitude', 'azimuth'):
        if field not in mut:
            continue
        val = mut[field]
        if val == '' or val is None:
            mut[field] = None
            continue
        try:
            v = float(val)
        except (TypeError, ValueError):
            mut[field] = None
            continue
        if not math.isfinite(v):
            mut[field] = None
            continue
        if field == 'latitude' and abs(v) > 90:
            mut[field] = None
        elif field == 'longitude' and abs(v) > 180:
            mut[field] = None
        else:
            mut[field] = v


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['user_id', 'email', 'phone_number']


class ImageSerializer(serializers.ModelSerializer):
    latitude = serializers.FloatField(required=False, allow_null=True)
    longitude = serializers.FloatField(required=False, allow_null=True)
    azimuth = serializers.FloatField(required=False, allow_null=True)
    file = serializers.ImageField(required=False, allow_null=True)  # ✅ ensure DRF knows about the file
    file_url = serializers.SerializerMethodField()  # ✅ expose full URL for frontend

    class Meta:
        model = Image
        fields = '__all__'

    def get_file_url(self, obj):
        """Return absolute URL for uploaded image."""
        request = self.context.get('request')
        if obj.file and request:
            return request.build_absolute_uri(obj.file.url)
        elif obj.file:
            return obj.file.url
        return None

    def validate(self, data):
        """
        Ensure empty strings or missing fields are converted to None.
        Reject NaN/inf so API JSON responses stay valid (strict JSON).
        """
        _sanitize_lat_lon_azimuth(data)
        return data

    def to_representation(self, instance):
        """Avoid NaN in floats breaking JSON encoding for existing bad rows."""
        ret = super().to_representation(instance)
        for key in ('latitude', 'longitude', 'azimuth'):
            v = ret.get(key)
            if isinstance(v, float) and not math.isfinite(v):
                ret[key] = None
        return ret

    def create(self, validated_data):
        """
        If latitude/longitude are missing, extract from EXIF data.
        """
        file = validated_data.get('file')
        if file:
            lat, lon = get_exif_location(file)
            if validated_data.get('latitude') is None and lat is not None:
                validated_data['latitude'] = lat
            if validated_data.get('longitude') is None and lon is not None:
                validated_data['longitude'] = lon
        _sanitize_lat_lon_azimuth(validated_data)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        """
        Handle updates: preserve EXIF fallback if user did not input lat/lon.
        """
        file = validated_data.get('file', None)
        if file and (validated_data.get('latitude') is None or validated_data.get('longitude') is None):
            lat, lon = get_exif_location(file)
            if validated_data.get('latitude') is None and lat is not None:
                validated_data['latitude'] = lat
            if validated_data.get('longitude') is None and lon is not None:
                validated_data['longitude'] = lon
        _sanitize_lat_lon_azimuth(validated_data)
        return super().update(instance, validated_data)